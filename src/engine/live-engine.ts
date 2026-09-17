import { randomUUID, createHash } from "node:crypto";
import type { BusySubmission } from "../shared/user-preferences";
import { z } from "zod";
import type { HostTools } from "./host-tools";
import { updateCompactions, type CompactionRecord } from "../shared/compaction";
import { captureUsage, emptyUsage, type SessionUsage } from "../shared/session-usage";
import { permissionContract, type PermissionMode } from "../shared/permission-mode";
import { isMcpToolApproval } from "../shared/mcp-tool-approval";
import { cancelTurnTerminals } from "./cancel-terminals";
import { updateItems } from "../shared/item-state";
import {
  AppServerTransport,
  AppServerError,
  type RpcServerRequest,
} from "./app-server-transport";
import { prepareAxiomProcess } from "./axiom-process";
import { hostToolContext } from "./host-tool-context";
import { readOpenAiModels, validateOpenAiSelection } from "./openai-provider";
import {
  parseNotification,
  parseServerRequest,
  parseResponse,
  validateTurnStart,
  validateThreadStart,
} from "./protocol-validation";
import type {
  EngineSnapshot,
  EngineEvent,
  EventEnvelope,
  EngineBinding,
  Scenario,
  Integration,
  AxiomRequestMetrics,
  AgentRecord,
} from "../shared/contracts";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
import { integrationServerName } from "../shared/integration-runtime";
import {
  coreClockResponse,
  deviceVerificationError,
  commandDecisionAllowed,
} from "../shared/core-compatibility";

export interface LiveContext {
  botInstructions?: string;
  permission?: PermissionMode;
  usageHistory?: SessionUsage;
  hostTools?: HostTools;
  mode?: "default" | "plan";
  cwd: string;
  profile: string;
  context: number | null;
  binding?: EngineBinding;
  integrations?: Integration[];
  backendHistory?: AxiomRequestMetrics[];
  compactionHistory?: CompactionRecord[];
  agentHistory?: AgentRecord[];
}
export interface LiveOptions {
  /** Parent desktop engine only; never automatically starts a model turn. */
  persistent?: {
    context: () => Promise<LiveContext>;
    allowed: () => boolean;
    heartbeatMs?: number;
    retryMs?: number;
  };
  runtime?: import("./core-runtime").CoreSelection;
  provider?:
    | "openai"
    | "synora_xai"
    | "synora_openrouter"
    | "synora_anthropic"
    | "synora_deepseek"
    | "synora_mistral"
    | "synora_compatible"
    | "synora_gemini";
  authorization?: () => Promise<string | undefined>;
  executable?: string;
  stateDirectory: string;
  endpoint: string;
  model: string;
  context: (conversationId: string) => LiveContext;
  bind: (conversationId: string, binding: EngineBinding) => void;
  sink: (event: EventEnvelope) => void;
  turnDeadlineMs?: number;
  /** Host-only idle budget. Explicit turnDeadlineMs remains an absolute limit. */
  turnIdleTimeoutMs?: number;
  initialSequence?: number;
}
export class LiveEngine {
  private usageBaseline?: ReturnType<typeof emptyUsage>;
  private hostTools?: HostTools;
  private hostCalls = new Set<AbortController>();
  private cancellation?: Promise<EngineSnapshot>;
  readonly mode = "live" as const;
  private state: EngineSnapshot = {
    connection: "disconnected",
    threadId: null,
    turnId: null,
    status: "idle",
    items: [],
    agents: [],
    approval: null,
    sequence: 0,
  };
  private transport?: AppServerTransport;
  private transportKey = "";
  private connectionJob?: Promise<void>;
  private maintenanceJob?: Promise<void>;
  private maintenanceTimer?: ReturnType<typeof setTimeout>;
  private connectionFailures = 0;
  private starting = false;
  private cancelled = false;
  private disposed = false;
  private log: EventEnvelope[] = [];
  private pending = new Map<string, ReturnType<typeof parseServerRequest>>();
  private userQuestions = new Map<
    string,
    Extract<
      ReturnType<typeof parseServerRequest>,
      { method: "item/tool/requestUserInput" }
    >
  >();
  private childTurns = new Map<string, string>();
  private deadline?: ReturnType<typeof setTimeout>;
  private deadlineEpoch = 0;
  private hasUpstreamProgress?: (sessionId: string) => Promise<boolean>;
  private ending?: Promise<void>;
  private terminalListeners = new Set<() => void>();
  private agents = new Map<string, EngineSnapshot["agents"][number]>();
  private agentRefreshes = new Map<string, Promise<void>>();
  private agentRefreshAgain = new Set<string>();
  private agentEpoch = 0;
  private earlyAgentMetrics: AxiomRequestMetrics[] = [];
  constructor(
    private options: LiveOptions,
    private prepare = prepareAxiomProcess,
  ) {
    this.state.sequence = options.initialSequence ?? 0;
    if (options.persistent) {
      this.state.appServer = { phase: "starting", attempts: 0 };
      this.scheduleConnection(0);
    }
  }
  private scheduleConnection(delay: number) {
    if (!this.options.persistent || this.disposed) return;
    clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = setTimeout(() => {
      this.maintenanceTimer = undefined;
      void this.keepConnected();
    }, delay);
    this.maintenanceTimer.unref?.();
  }
  private keepConnected(): Promise<void> {
    if (this.maintenanceJob) return this.maintenanceJob;
    const job = this.maintainConnection().finally(() => {
      if (this.maintenanceJob === job) this.maintenanceJob = undefined;
    });
    this.maintenanceJob = job;
    return job;
  }
  private async maintainConnection() {
    const persistent = this.options.persistent;
    if (!persistent || this.disposed) return;
    let delay = persistent.heartbeatMs ?? 15000;
    try {
      if (
        !persistent.allowed() ||
        this.starting ||
        this.cancellation ||
        ["running", "waiting"].includes(this.state.status)
      ) {
        delay = 500;
        return;
      }
      if (
        !this.transport ||
        this.transport.diagnostics.closed ||
        !this.transportKey
      ) {
        await this.ready();
      } else {
        const transport = this.transport;
        try {
          // Original local Core RPC; no inference, provider request, or thread creation.
          const reply = await transport.request<
            import("../protocol/codex-0.153.4/v2/ThreadLoadedListResponse").ThreadLoadedListResponse
          >("thread/loaded/list", { limit: 1 }, 5000);
          if (
            !reply ||
            !Array.isArray(reply.data) ||
            reply.data.some((v) => typeof v !== "string") ||
            (reply.nextCursor !== null && typeof reply.nextCursor !== "string")
          )
            throw Error("Invalid App Server heartbeat response");
          if (this.disposed || this.transport !== transport) return;
        } catch (error) {
          // An active foreground operation owns its deadline and cancellation.
          if (
            this.starting ||
            ["running", "waiting"].includes(this.state.status)
          )
            return;
          await transport.close();
          throw error;
        }
      }
      if (this.disposed) return;
      if (
        !this.transport ||
        this.transport.diagnostics.closed ||
        this.state.connection !== "live"
      ) {
        delay = 500;
        return;
      }
      this.connectionFailures = 0;
      this.state.appServer = {
        phase: "ready",
        attempts: 0,
        pid: this.transport?.pid,
        checkedAt: Date.now(),
      };
      // Keep idle telemetry small: do not clone/persist conversation history
      // or retrigger terminal/worker cleanup on every heartbeat.
      this.emit({
        kind: "connection",
        state: "live",
        appServer: this.state.appServer,
      });
    } catch (error) {
      if (this.disposed) return;
      if (!this.transport || this.transport.diagnostics.closed)
        this.state.connection = "disconnected";
      this.connectionFailures++;
      delay = Math.min(
        30000,
        (persistent.retryMs ?? 1000) *
          2 ** Math.min(this.connectionFailures - 1, 5),
      );
      this.state.appServer = {
        phase: "offline",
        attempts: this.connectionFailures,
        retryAt: Date.now() + delay,
        message:
          error instanceof Error
            ? error.message
            : "App Server connection failed",
      };
      this.publish();
    } finally {
      this.scheduleConnection(delay);
    }
  }
  /** Connect/restore only. Never calls turn/start and never replays a tool. */
  private async ready() {
    const persistent = this.options.persistent;
    if (!persistent || this.disposed) return;
    if (this.starting || this.cancellation) return;
    if (
      this.state.conversationId &&
      this.options.context(this.state.conversationId).binding
    ) {
      await this.restore(this.state.conversationId);
      return;
    }
    const context = await persistent.context();
    // Resolving the idle context may await credentials/catalog I/O. A user can
    // start a turn in that interval. The stale idle settings must not close and
    // replace the transport now owned by that foreground operation.
    if (this.disposed || this.starting || this.cancellation ||
        ["running", "waiting"].includes(this.state.status)) return;
    this.cancelled = false;
    await this.connect(context);
  }
  snapshot(): EngineSnapshot {
    return structuredClone(this.state);
  }
  invalidateIntegrations() {
    // Credentials/executors may change while the model/profile key is the same.
    // Rebuild our owned process/transport at the next turn; do not reuse a
    // captured token or stale mounted catalog after an explicit edit.
    this.transportKey = "";
    this.state.mcpServers = [];
    this.publish();
    this.scheduleConnection(0);
  }
  private emit(event: EngineEvent) {
    const record: EventEnvelope = {
      sequence: ++this.state.sequence,
      at: Date.now(),
      simulated: false,
      conversationId: this.state.conversationId,
      event: structuredClone(event),
    };
    this.log.push(record);
    if (this.log.length > 2000) this.log.shift();
    this.options.sink(record);
  }
  private publish() {
    this.emit({ kind: "snapshot", snapshot: this.snapshot() });
  }
  private upsert(item: ThreadItem) {
    const index = this.state.items.findIndex((i) => i.id === item.id);
    if (index < 0) this.state.items.push(structuredClone(item));
    else this.state.items[index] = structuredClone(item);
    if (item.type === "subAgentActivity") {
      const id = item.agentThreadId, parentId = this.state.threadId;
      if (!parentId || id === parentId)
        throw new Error("A thread cannot be its own child");
      const old = this.agents.get(id);
      // Current Core announces children without a collab spawn result. Keep its
      // original identity; obtain task, result and terminal status by read only.
      // In particular, 'completed' activity alone is not a successful tool result.
      this.agents.set(id, {
        ...old, id, parentId: old?.parentId ?? parentId,
        name: old?.name ?? item.agentPath,
        task: old?.task ?? "", result: old?.result ?? "", simulated: false,
        status: item.kind === "interrupted" ? "interrupted" : old?.status ?? "pendingInit",
      });
      this.drainAgentMetrics(id);
      void this.refreshAgent(id);
      this.publishAgents();
    }
    if (item.type === "collabAgentToolCall") {
      if (item.senderThreadId !== this.state.threadId)
        throw new Error("Agent tool sender does not match the owning thread");
      for (const id of item.receiverThreadIds) {
        if (id === this.state.threadId)
          throw new Error("A thread cannot be its own child");
        const old = this.agents.get(id),
          reported = item.agentsStates[id];
        // Wait/close refer to an existing child; they must not rewrite its parent.
        const parentId = old?.parentId ?? item.senderThreadId;
        this.agents.set(id, {
          ...old,
          id,
          name: old?.name ?? id,
          parentId,
          task: item.prompt ?? old?.task ?? "",
          status: reported?.status ?? old?.status ?? "running",
          result: reported?.message ?? old?.result ?? "",
          simulated: false,
          closed:
            item.tool === "resumeAgent" && item.status === "completed"
              ? false
              : old?.closed ||
                (item.tool === "closeAgent" && item.status === "completed"),
        });
        this.drainAgentMetrics(id);
        void this.refreshAgent(id);
      }
      this.publishAgents();
    }
  }
  private publishAgents() {
    this.state.agents = [...this.agents.values()];
    this.emit({ kind: "agents", agents: structuredClone(this.state.agents) });
  }
  /** Read metadata/history, never resume or spawn a child to obtain its name. */
  private refreshAgent(id: string): Promise<void> {
    const pending = this.agentRefreshes.get(id);
    if (pending) {
      this.agentRefreshAgain.add(id);
      return pending;
    }
    const transport = this.transport,
      parent = this.state.threadId,
      epoch = this.agentEpoch;
    if (!transport || !this.agents.has(id)) return Promise.resolve();
    const job = (async () => {
      do {
        this.agentRefreshAgain.delete(id);
        try {
          const { thread } = parseResponse(
            "read",
            await transport.request(
              "thread/read",
              { threadId: id, includeTurns: true },
              10000,
            ),
          );
          if (
            this.disposed ||
            this.transport !== transport ||
            this.state.threadId !== parent ||
            epoch !== this.agentEpoch
          )
            return;
          const agent = this.agents.get(id);
          if (!agent) return;
          if (thread.id !== id || thread.parentThreadId !== agent.parentId)
            throw new Error(
              "Child metadata lineage does not match its original tool call",
            );
          agent.name = thread.agentNickname ?? thread.name ?? agent.name;
          agent.task ||= thread.preview;
          agent.coreSessionId = thread.sessionId;
          agent.model = thread.model;
          agent.profile = thread.reasoningEffort;
          agent.metadataError = null;
          for (const turn of thread.turns) {
            if (
              (!this.childTurns.has(id) ||
                this.childTurns.get(id) === turn.id) &&
              !(
                agent.turnId === turn.id &&
                agent.completedAt !== undefined &&
                turn.status === "inProgress"
              )
            ) {
              agent.turnId = turn.id;
              agent.startedAt =
                turn.startedAt === null ? undefined : turn.startedAt * 1000;
              agent.completedAt =
                turn.completedAt === null ? undefined : turn.completedAt * 1000;
              agent.status =
                turn.status === "completed"
                  ? "completed"
                  : turn.status === "failed"
                    ? "errored"
                    : turn.status === "interrupted"
                      ? "interrupted"
                      : "running";
            }
            for (const item of turn.items)
              if (
                turn.status !== "inProgress" ||
                !agent.activity?.some((v) => v.id === item.id)
              )
                this.childItem(agent, item);
          }
          this.publishAgents();
        } catch (error) {
          if (
            this.disposed ||
            this.transport !== transport ||
            this.state.threadId !== parent ||
            epoch !== this.agentEpoch
          )
            return;
          const agent = this.agents.get(id);
          if (agent) {
            agent.metadataError =
              error instanceof Error ? error.message : String(error);
            this.publishAgents();
          }
        }
      } while (this.agentRefreshAgain.has(id));
    })();
    this.agentRefreshes.set(id, job);
    void job.finally(() => {
      if (this.agentRefreshes.get(id) === job) this.agentRefreshes.delete(id);
    });
    return job;
  }
  private childItem(agent: AgentRecord, item: ThreadItem) {
    agent.activity ??= [];
    const index = agent.activity.findIndex((v) => v.id === item.id);
    if (index < 0) agent.activity.push(structuredClone(item));
    else agent.activity[index] = structuredClone(item);
    if (item.type === "agentMessage") agent.result = item.text;
  }
  private drainAgentMetrics(id: string) {
    const pending = this.earlyAgentMetrics.filter((m) => m.threadId === id);
    this.earlyAgentMetrics = this.earlyAgentMetrics.filter(
      (m) => m.threadId !== id,
    );
    for (const metrics of pending) this.childMetrics(metrics);
  }
  private childMetrics(metrics: AxiomRequestMetrics) {
    const agent = this.agents.get(metrics.threadId);
    if (!agent) {
      if (this.earlyAgentMetrics.length < 64)
        this.earlyAgentMetrics.push(metrics);
      return;
    }
    agent.backendRequests ??= [];
    if (
      agent.backendRequests.some(
        (m) =>
          m.responseId === metrics.responseId &&
          m.turnId === metrics.turnId &&
          m.sessionId === metrics.sessionId,
      )
    )
      return;
    agent.backendRequests.push(metrics);
    this.publishAgents();
  }
  private failed(error: unknown) {
    for (const call of this.hostCalls)
      call.abort(new Error("Owning turn failed"));
    clearTimeout(this.deadline);
    this.state.error = {
      code:
        error instanceof AppServerError
          ? String(error.code)
          : "LIVE_ENGINE_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
    this.state.status = "failed";
    this.state.compactions = (this.state.compactions ?? []).map((r) =>
      r.status === "running"
        ? { ...r, status: "failed", completedAt: Date.now() }
        : r,
    );
    this.state.approval = null;
    this.pending.clear();
    this.userQuestions.clear();
    this.state.questions = [];
    this.publish();
    for (const notify of this.terminalListeners) notify();
  }
  private renewForActivity(message: ReturnType<typeof parseNotification>, items: ThreadItem[]) {
    const p = message.params;
    const item = message.method === "item/started" || message.method === "item/completed" ? message.params.item : null;
    // Call only after validating the current root/child identity. Heartbeats,
    // duplicate records and metadata refreshes are not semantic progress.
    if (this.options.turnDeadlineMs === undefined && this.deadline && !this.cancelled && !this.cancellation &&
      ((item && JSON.stringify(items.find(i => i.id === item.id)) !== JSON.stringify(item)) ||
        ("delta" in p && typeof p.delta === "string" && p.delta.length > 0 &&
          ["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/plan/delta"].includes(message.method))))
      this.armDeadline();
  }
  private notification(raw: unknown) {
    const message = parseNotification(raw);
    const p = message.params;
    if (message.method === "thread/started") {
      const thread = message.params.thread;
      if (
        thread.parentThreadId &&
        thread.parentThreadId === this.state.threadId
      ) {
        const old = this.agents.get(thread.id);
        this.agents.set(thread.id, {
          ...old,
          id: thread.id,
          name: thread.agentNickname ?? old?.name ?? thread.id,
          parentId: thread.parentThreadId,
          task: thread.preview || old?.task || "",
          status: "running",
          result: old?.result ?? "",
          simulated: false,
          coreSessionId: thread.sessionId,
          model: thread.model,
          profile: thread.reasoningEffort,
        });
        this.drainAgentMetrics(thread.id);
        this.publishAgents();
      }
    }
    if (
      "threadId" in p &&
      typeof p.threadId === "string" &&
      this.agents.has(p.threadId)
    ) {
      const agent = this.agents.get(p.threadId)!;
      if (message.method === "turn/started") {
        this.childTurns.set(p.threadId, message.params.turn.id);
        agent.status = "running";
        agent.closed = false;
        agent.turnId = message.params.turn.id;
        agent.startedAt = Date.now();
        this.publishAgents();
      }
      if (message.method === "thread/closed") {
        agent.closed = true;
        this.publishAgents();
      }
      if (
        "turnId" in p &&
        p.turnId !== this.childTurns.get(agent.id) &&
        p.turnId !== agent.turnId
      )
        return;
      if (message.method === "turn/completed" && message.params.turn.id !== agent.turnId) return;
      if (message.method === "turn/completed" && message.params.turn.status === "inProgress")
        throw new AppServerError("PROTOCOL_LIFECYCLE", "Core emitted child turn/completed with a non-terminal inProgress status");
      if (agent.parentId === this.state.threadId && !agent.closed && agent.status === "running" &&
        "turnId" in p && p.turnId === agent.turnId)
        this.renewForActivity(message, agent.activity ?? []);
      if (
        message.method === "item/started" ||
        message.method === "item/completed"
      )
        this.childItem(agent, message.params.item);
      if (
        [
          "item/agentMessage/delta",
          "item/commandExecution/outputDelta",
          "item/reasoning/textDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/plan/delta",
        ].includes(message.method)
      ) {
        agent.activity = updateItems(agent.activity ?? [], message);
        this.publishAgents();
      }
      if (
        message.method === "item/completed" &&
        message.params.item.type === "agentMessage"
      )
        agent.result = message.params.item.text;
      if (message.method === "turn/completed") {
        agent.completedAt = Date.now();
        for (const item of message.params.turn.items)
          this.childItem(agent, item);
        void this.refreshAgent(agent.id);
        agent.status =
          message.params.turn.status === "completed"
            ? "completed"
            : message.params.turn.status === "failed"
              ? "errored"
              : message.params.turn.status === "interrupted"
                ? "interrupted"
                : "running";
        if (message.params.turn.status !== "inProgress") {
          this.childTurns.delete(p.threadId);
          for (const [id, request] of this.pending)
            if (
              "threadId" in request.params &&
              request.params.threadId === p.threadId
            )
              this.pending.delete(id);
          for (const [id, request] of this.userQuestions)
            if (request.params.threadId === p.threadId)
              this.userQuestions.delete(id);
          this.refreshRequests();
        }
      }
      if (
        message.method === "item/started" ||
        message.method === "item/completed" ||
        message.method === "turn/completed"
      )
        this.publishAgents();
    }
    if (message.method === "serverRequest/resolved") {
      for (const [id, request] of this.pending)
        if (
          request.id === message.params.requestId &&
          "threadId" in request.params &&
          request.params.threadId === message.params.threadId
        )
          this.pending.delete(id);
      for (const [id, request] of this.userQuestions)
        if (
          request.id === message.params.requestId &&
          request.params.threadId === message.params.threadId
        )
          this.userQuestions.delete(id);
      this.refreshRequests();
    }
    if (!("threadId" in p) || p.threadId !== this.state.threadId) return;
    // Ignore delayed output from an earlier turn in the same durable thread.
    if ("turnId" in p && p.turnId !== this.state.turnId) return;
    if (
      message.method === "turn/completed" &&
      message.params.turn.id !== this.state.turnId
    )
      return;
    if (
      message.method === "turn/completed" &&
      message.params.turn.status === "inProgress"
    )
      throw new AppServerError(
        "PROTOCOL_LIFECYCLE",
        "Core emitted turn/completed with a non-terminal inProgress status",
      );
    // Only owned semantic activity refreshes the default idle budget. Repeated
    // connection/status/usage notices and stale/foreign turns do not keep work alive.
    this.renewForActivity(message, this.state.items);
    this.state.compactions = updateCompactions(
      this.state.compactions ?? [],
      message,
      Date.now(),
    );
    if (message.method === "turn/started") {
      this.state.turnId = message.params.turn.id;
      this.state.status = "running";
      this.state.startedAt = Date.now();
      this.state.firstDeltaAt = undefined;
      this.state.completedAt = undefined;
      this.state.items = structuredClone(message.params.turn.items);
      this.state.error = null;
    } else if (
      message.method === "item/started" ||
      message.method === "item/completed"
    ) {
      this.upsert(message.params.item);
    } else if (message.method === "item/agentMessage/delta") {
      this.state.items = updateItems(this.state.items, message);
      this.state.firstDeltaAt ??= Date.now();
    } else if (message.method === "item/commandExecution/outputDelta") {
      this.state.items = updateItems(this.state.items, message);
    } else if (
      message.method === "item/plan/delta" ||
      message.method === "item/reasoning/textDelta" ||
      message.method === "item/reasoning/summaryTextDelta" ||
      message.method === "item/reasoning/summaryPartAdded"
    ) {
      this.state.items = updateItems(this.state.items, message);
    } else if (message.method === "thread/tokenUsage/updated") {
      this.state.tokenUsage = message.params.tokenUsage;
      this.state.usage = captureUsage(message.params.threadId, message.params.turnId,
        message.params.tokenUsage, Date.now(), this.usageBaseline);
    } else if (message.method === "turn/completed") {
      // App Server may return summary items: retain previously streamed tools/user
      // items rather than deleting them with a shorter terminal summary.
      for (const item of message.params.turn.items) this.upsert(item);
      this.state.status =
        message.params.turn.status === "inProgress"
          ? "running"
          : message.params.turn.status;
      this.state.completedAt = Date.now();
      this.state.approval = null;
      this.pending.clear();
      this.userQuestions.clear();
      this.state.questions = [];
      this.state.error = message.params.turn.error
        ? { code: "TURN_FAILED", message: message.params.turn.error.message }
        : null;
      clearTimeout(this.deadline);
      for (const notify of this.terminalListeners) notify();
    }
    this.emit({ kind: "protocol", payload: message });
    if (
      message.method === "turn/completed" ||
      message.method === "thread/tokenUsage/updated"
    )
      this.publish();
  }
  private request(raw: RpcServerRequest) {
    if (
      raw.method === "mcpServer/elicitation/request" &&
      (raw.params as { mode?: unknown } | null)?.mode ===
        "openai/userVerification"
    ) {
      this.transport!.respond(
        raw.id,
        deviceVerificationError(
          raw.params,
          new Set([
            ...(this.state.threadId ? [this.state.threadId] : []),
            ...this.agents.keys(),
          ]),
        ),
      );
      return;
    }
    if (raw.method === "currentTime/read") {
      this.transport!.respond(
        raw.id,
        coreClockResponse(
          raw.params,
          new Set([
            ...(this.state.threadId ? [this.state.threadId] : []),
            ...this.agents.keys(),
          ]),
        ),
      );
      return;
    }
    const request = parseServerRequest(raw);
    if (request.method === "mcpServer/elicitation/request" && isMcpToolApproval(request.params)) {
      const p = request.params;
      const root = p.threadId === this.state.threadId && p.turnId === this.state.turnId;
      const child = this.agents.has(p.threadId) && this.childTurns.get(p.threadId) === p.turnId;
      if (!(root || child) || !["running", "waiting"].includes(this.state.status)) {
        this.transport!.respond(request.id, { error: { code: -32602, message: "MCP approval does not belong to the active Synora turn" } });
        return;
      }
      if (root && this.state.conversationId && this.options.context(this.state.conversationId).permission === "full") {
        // Full access explicitly authorizes execution without further Synora
        // prompts. This accepts only this call, never a persisted MCP grant.
        this.transport!.respond(request.id, {result:{action:"accept",content:{},_meta:null}});
        return;
      }
      // Show the original message/parameters. Only a real UI decision responds.
      this.pending.set(randomUUID(), request);
      this.refreshRequests();
      return;
    }
    if (request.method === "item/tool/call") {
      const transport = this.transport!,
        extension = this.hostTools;
      if (
        !extension ||
        request.params.namespace !== null ||
        request.params.threadId !== this.state.threadId ||
        request.params.turnId !== this.state.turnId ||
        !["running", "waiting"].includes(this.state.status) ||
        !extension.catalog.some((t) => t.name === request.params.tool)
      ) {
        transport.respond(request.id, {
          error: {
            code: -32602,
            message: "Host tool is not mounted for this active Synora turn",
          },
        });
        return;
      }
      const controller = new AbortController();
      this.hostCalls.add(controller);
      void extension
        .call(request.params, controller.signal)
        .then(
          (result) => {
            if (
              !controller.signal.aborted &&
              this.transport === transport &&
              !transport.diagnostics.closed
            )
              transport.respond(request.id, { result });
          },
          (error) => {
            if (
              !controller.signal.aborted &&
              this.transport === transport &&
              !transport.diagnostics.closed
            )
              transport.respond(request.id, {
                result: {
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text:
                        error instanceof Error
                          ? error.message
                          : "Host tool failed",
                    },
                  ],
                },
              });
          },
        )
        .finally(() => this.hostCalls.delete(controller));
      return;
    }
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval" ||
      request.method === "item/permissions/requestApproval" ||
      request.method === "item/tool/requestUserInput"
    ) {
      const root =
        request.params.threadId === this.state.threadId &&
        request.params.turnId === this.state.turnId;
      const child =
        this.agents.has(request.params.threadId) &&
        this.childTurns.get(request.params.threadId) === request.params.turnId;
      if (
        !(root || child) ||
        !["running", "waiting"].includes(this.state.status)
      ) {
        this.transport!.respond(request.id, {
          error: {
            code: -32602,
            message: "Approval does not belong to the active Synora turn",
          },
        });
        return;
      }
      const id = randomUUID();
      if (request.method === "item/tool/requestUserInput") {
        const ids = request.params.questions.map((q) => q.id);
        if (new Set(ids).size !== ids.length || ids.some((v) => !v)) {
          this.transport!.respond(request.id, {
            error: {
              code: -32602,
              message: "User question IDs must be unique and nonempty",
            },
          });
          return;
        }
        this.userQuestions.set(id, request);
        this.refreshRequests();
        return;
      }
      this.pending.set(id, request);
      if (!this.state.approval) {
        this.state.approval = { id, params: request.params };
        this.state.status = "waiting";
        this.emit({ kind: "approval", id, params: request.params });
      }
      this.refreshRequests();
      return;
    }
    // Fail explicitly, never fabricate a successful tool or let an unanswered RPC
    // leave a turn waiting forever. Additional capabilities get real executors.
    this.transport!.respond(request.id, {
      error: {
        code: -32601,
        message: `Synora has not mounted a handler for ${request.method}`,
      },
    });
  }
  private refreshRequests() {
    const next = this.pending.entries().next().value;
    this.state.approval = next
      ? {
          id: next[0],
          params: parseServerRequest(next[1]).params as NonNullable<
            EngineSnapshot["approval"]
          >["params"],
        }
      : null;
    this.state.questions = [...this.userQuestions].map(([id, request]) => ({
      id,
      params: request.params,
    }));
    if (["running", "waiting"].includes(this.state.status))
      this.state.status =
        next || this.state.questions.some((q) => q.params.isBlocking)
          ? "waiting"
          : "running";
    this.publish();
  }
  private async connect(context: LiveContext) {
    // Foreground send, startup and reconnect share exactly one initialize.
    while (this.connectionJob) await this.connectionJob;
    if (this.disposed || this.cancelled)
      throw Error("Engine startup was cancelled");
    const job = this.connectOnce(context);
    this.connectionJob = job;
    try {
      await job;
    } finally {
      if (this.connectionJob === job) this.connectionJob = undefined;
    }
  }
  private async connectOnce(context: LiveContext) {
    const key = JSON.stringify([
      context.profile,
      context.context,
      context.integrations ?? [],
      // Core ignores resume configuration overrides for an already-loaded
      // thread. Recreate only our owned transport on an explicit policy change,
      // then cold-resume the SAME durable thread/session and verify its policy.
      context.permission ?? "ask",
    ]);
    if (
      this.transport &&
      !this.transport.diagnostics.closed &&
      this.transportKey === key
    ) {
      if (this.options.provider === "openai") {
        const models = await readOpenAiModels(this.transport);
        validateOpenAiSelection(
          models,
          this.options.model,
          context.profile || undefined,
        );
        this.state.modelCatalog = models;
      }
      return;
    }
    this.state.connection = "disconnected";
    if (this.transport) {
      const prior = this.transport;
      this.transport = undefined;
      await prior.close();
    }
    if (this.options.persistent) {
      this.state.appServer = {
        phase:
          this.state.appServer?.checkedAt || this.connectionFailures
            ? "reconnecting"
            : "starting",
        attempts: this.connectionFailures,
      };
      this.publish();
    }
    const config = await this.prepare({
      ...this.options,
      ...context,
      onMetrics: (metrics) => {
        if (
          this.disposed ||
          this.cancelled ||
          metrics.sessionId !== this.state.sessionId
        )
          return;
        if (metrics.threadId !== this.state.threadId) {
          this.childMetrics(metrics);
          return;
        }
        if (this.state.turnId && metrics.turnId !== this.state.turnId) return;
        const previous = this.state.backendRequests ?? [];
        if (previous.some((r) => r.responseId === metrics.responseId)) return;
        this.state.backendRequests = [...previous, metrics];
        this.emit({ kind: "backend-metrics", metrics });
      },
    });
    if (this.disposed || this.cancelled) {
      await config.cleanup?.();
      throw new Error("Engine startup was cancelled");
    }
    this.hasUpstreamProgress = config.hasProgress;
    const transport = new AppServerTransport({
      ...config,
      onNotification: (v) => this.notification(v),
      onRequest: (v) => this.request(v),
      onClose: (error) => {
        if (this.transport !== transport) return;
        this.state.connection = "disconnected";
        if (this.options.persistent)
          this.state.appServer = {
            phase: "reconnecting",
            attempts: this.connectionFailures,
            message: error.message,
          };
        if (["running", "waiting"].includes(this.state.status))
          this.failed(error);
        else this.publish();
        this.scheduleConnection(this.options.persistent?.retryMs ?? 1000);
      },
    });
    this.transport = transport;
    this.state.mcpServers = [];
    this.transportKey = key;
    try {
      await transport.request("initialize", {
        clientInfo: {
          name: "synora_harness_desktop",
          title: "Synora Harness Desktop",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      transport.notify("initialized");
      if (this.options.provider === "openai") {
        config.models = await readOpenAiModels(transport);
        validateOpenAiSelection(
          config.models,
          this.options.model,
          context.profile || undefined,
        );
      }
      if (process.platform === "win32") {
        const readiness = parseResponse(
          "windowsReadiness",
          await transport.request("windowsSandbox/readiness", {}),
        );
        if (readiness.status !== "ready")
          throw new Error(
            `Windows native sandbox is ${readiness.status}. In Settings, check native tool setup and complete the Windows sandbox setup before starting a live turn. No model request was sent.`,
          );
      }
      this.state.modelCatalog = config.models;
      this.state.selection = {
        model: this.options.model,
        profile: context.profile,
        context: context.context,
        contextRequestField:
          this.options.provider !== undefined
            ? "core-managed"
            : "context_window",
      };
      this.state.connection = "live";
      if (this.options.persistent)
        this.state.appServer = {
          phase: "ready",
          attempts: 0,
          pid: transport.pid,
          checkedAt: Date.now(),
        };
      this.publish();
    } catch (error) {
      this.transport = undefined;
      await transport.close();
      throw error;
    }
  }
  private validateBinding(context: LiveContext) {
    const binding = context.binding;
    // Approval/reviewer/sandbox can change on the same Core thread. Every start
    // resumes with the selected policy and verifies Core's acknowledgement below
    // before inference; provider/model/cwd and original thread identity stay fixed.
    // Core persists dynamicTools at thread/start; thread/resume cannot replace
    // that catalog. Never instruct a resumed model to call newly invented tools.
    const hostToolCatalogHash = context.hostTools
      ? createHash("sha256")
          .update(JSON.stringify(context.hostTools.catalog))
          .digest("hex")
      : undefined;
    if (binding && binding.hostToolCatalogHash !== hostToolCatalogHash)
      throw new Error(
        "This supervisor thread has a different or unversioned host tool catalog. Its history is preserved; open a new conversation to use the current tools. No model request was sent.",
      );
    if (
      binding &&
      (binding.endpoint !== this.options.endpoint ||
        binding.model !== this.options.model ||
        binding.cwd !== context.cwd)
    )
      throw new Error(
        "This conversation belongs to a different provider, model or workspace. Open a new conversation to change it.",
      );
    return hostToolCatalogHash;
  }
  private async attach(conversationId: string, context: LiveContext) {
    const binding = context.binding;
    const permission = context.permission ?? "ask";
    const policy = permissionContract(permission);
    const hostToolCatalogHash = this.validateBinding(context);
    await this.connect(context);
    this.hostTools = context.hostTools;
    if (this.cancelled) throw new Error("Engine startup was cancelled");
    const params = {
      model: this.options.model,
      modelProvider: this.options.provider ?? "synora_axiom",
      cwd: context.cwd,
      approvalPolicy: policy.approvalPolicy,
      approvalsReviewer: policy.approvalsReviewer,
      sandbox: policy.sandbox,
      ...hostToolContext(context.cwd),
      ...(context.hostTools?.instructions || context.botInstructions
        ? {
            developerInstructions: [
              hostToolContext(context.cwd).developerInstructions,
              context.botInstructions,
              context.hostTools?.instructions,
            ]
              .filter(Boolean)
              .join("\n"),
          }
        : {}),
      config: {
        ...(context.profile ? { model_reasoning_effort: context.profile } : {}),
        ...(context.context !== null
          ? { model_context_window: context.context }
          : {}),
      },
      ...(!binding && context.hostTools
        ? { dynamicTools: context.hostTools.catalog }
        : {}),
    };
    if (!binding) validateThreadStart(params);
    const response = await this.transport!.request(
      binding ? "thread/resume" : "thread/start",
      binding ? { ...params, threadId: binding.threadId } : params,
    );
    if (this.cancelled) throw new Error("Engine startup was cancelled");
    const started = parseResponse(binding ? "resume" : "start", response);
    if (started.sandbox.type !== policy.sandboxType ||
        started.approvalPolicy !== policy.approvalPolicy || started.approvalsReviewer !== policy.approvalsReviewer)
      throw new Error(
        `Core selected ${started.sandbox.type}, ${started.approvalPolicy}, ${started.approvalsReviewer}; it did not confirm the requested permissions (${policy.sandbox}, ${policy.approvalPolicy}, ${policy.approvalsReviewer}). Check host policy before continuing. No model request was sent.`,
      );
    if (
      binding &&
      (started.thread.id !== binding.threadId ||
        started.thread.sessionId !== binding.sessionId)
    )
      throw new Error("App Server resumed a different thread/session identity");
    this.state.threadId = started.thread.id;
    this.state.sessionId = started.thread.sessionId;
    this.options.bind(conversationId, {
      threadId: started.thread.id,
      sessionId: started.thread.sessionId,
      endpoint: this.options.endpoint,
      model: this.options.model,
      cwd: context.cwd,
      ...(permission !== "ask" ? { permission } : {}),
      ...(hostToolCatalogHash ? { hostToolCatalogHash } : {}),
    });
    await this.refreshMcp(context);
    if (binding) {
      const cursors = new Set<string>();
      let cursor: string | null = null;
      const until = Date.now() + 60000;
      do {
        if (this.cancelled) throw new Error("Session recovery was cancelled");
        if (Date.now() > until)
          throw new Error("Session history recovery exceeded its deadline");
        const page: ReturnType<typeof parseResponse<"items">> = parseResponse(
          "items",
          await this.transport!.request("thread/items/list", {
            threadId: binding.threadId,
            cursor,
            sortDirection: "asc",
            limit: 100,
          }),
        );
        this.emit({
          kind: "history",
          threadId: binding.threadId,
          items: page.data.map((v) => v.item),
        });
        for (const { item } of page.data)
          if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") this.upsert(item);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("App Server repeated a history cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    this.publish();
  }
  private async refreshMcp(context: LiveContext) {
    const expected = (context.integrations ?? []).filter(
      (v) => v.enabled && v.executor && v.executor !== "configuration-only",
    );
    // Core plugins can mount MCP servers independently of Synora's manually
    // configured integrations. Always read the original thread inventory;
    // the configured list only determines explicit readiness requirements.
    const until = Date.now() + 15000;
    for (;;) {
      if (this.cancelled) throw new Error("MCP startup was cancelled");
      const servers: NonNullable<EngineSnapshot["mcpServers"]> = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const page: ReturnType<typeof parseResponse<"mcp">> = parseResponse(
          "mcp",
          await this.transport!.request(
            "mcpServerStatus/list",
            {
              threadId: this.state.threadId,
              detail: "full",
              limit: 100,
              cursor,
            },
            10000,
          ),
        );
        servers.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("App Server repeated an MCP inventory cursor");
        if (cursor) cursors.add(cursor);
        if (Date.now() > until && cursor)
          throw new Error("MCP inventory exceeded its startup deadline");
      } while (cursor);
      this.state.mcpServers = servers;
      this.publish();
      const pending = expected.filter(
        (v) =>
          servers.find((s) => s.name === integrationServerName(v.id))
            ?.runtimeStatus !== "connected",
      );
      if (!pending.length) {
        for (const v of expected.filter((v) => v.executor === "searxng")) {
          const server = servers.find(
            (s) => s.name === integrationServerName(v.id),
          )!;
          const names = Object.values(server.tools).map((t) => t?.name);
          if (!names.includes("web_search") || !names.includes("web_fetch"))
            throw new Error(
              `${v.name}: App Server did not mount both web executors`,
            );
        }
        return;
      }
      const failed = pending.find((v) =>
        ["failed", "cancelled", "authenticationRequired", "disabled"].includes(
          servers.find((s) => s.name === integrationServerName(v.id))
            ?.runtimeStatus ?? "",
        ),
      );
      if (failed || Date.now() > until)
        throw new Error(
          `${(failed ?? pending[0]).name}: MCP executor did not connect; inspect its runtime status before retrying`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async restore(conversationId: string): Promise<EngineSnapshot> {
    if (
      this.disposed ||
      this.cancellation ||
      this.starting ||
      ["running", "waiting"].includes(this.state.status)
    )
      throw new Error("An engine operation is already active");
    const context = this.options.context(conversationId);
    if (!context.binding)
      throw new Error("This conversation has no live session to restore");
    // A deterministic identity error is not a transport outage. Reject before
    // replacing conversation/session state or closing a healthy resident Core,
    // so its maintenance loop never adopts an incompatible conversation.
    this.validateBinding(context);
    const history = this.priorUsage(conversationId, context);
    this.usageBaseline = undefined; // Recover a measurement, never invent a turn baseline.
    this.starting = true;
    this.cancelled = false;
    this.agents.clear();
    this.agentEpoch++;
    this.agentRefreshes.clear();
    this.agentRefreshAgain.clear();
    this.childTurns.clear();
    this.earlyAgentMetrics = [];
    for (const agent of context.agentHistory ?? [])
      if (!agent.simulated && agent.parentId === context.binding.threadId)
        this.agents.set(agent.id, structuredClone(agent));
    this.state = {
      ...this.state,
      conversationId,
      threadId: null,
      sessionId: undefined,
      turnId: null,
      status: "running",
      items: [],
      approval: null,
      questions: [],
      error: null,
      startedAt: undefined,
      firstDeltaAt: undefined,
      completedAt: undefined,
      tokenUsage: history?.value,
      usage: history,
      backendRequests: [],
      agents: [...this.agents.values()],
      compactions: (context.compactionHistory ?? []).map((r) =>
        r.status === "running" ? { ...r, status: "unknown" } : r,
      ),
    };
    this.publish();
    try {
      await this.attach(conversationId, context);
      const page = parseResponse(
        "turns",
        await this.transport!.request("thread/turns/list", {
          threadId: this.state.threadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "full",
        }),
      );
      const last = page.data[0];
      this.state.turnId = last?.id ?? null;
      // Never carry another conversation's observed timings into recovered
      // history. Core provides second-resolution dates and a precise duration;
      // anchor that duration to its start. First-text latency is not reported
      // by this history API, so it remains unavailable instead of being guessed.
      this.state.startedAt = last?.startedAt == null ? undefined : last.startedAt * 1000;
      this.state.completedAt = last?.status === "inProgress" ? undefined
        : this.state.startedAt !== undefined && last?.durationMs != null
          ? this.state.startedAt + last.durationMs
          : last?.completedAt == null ? undefined : last.completedAt * 1000;
      this.state.items = last?.items ?? [];
      for (const item of [...this.state.items]) this.upsert(item);
      await Promise.all(
        [...this.agents.keys()].map((id) => this.refreshAgent(id)),
      );
      this.state.backendRequests = (context.backendHistory ?? []).filter(
        (v) =>
          v.threadId === this.state.threadId &&
          v.sessionId === this.state.sessionId &&
          v.turnId === last?.id,
      );
      this.state.status =
        last?.status === "inProgress"
          ? "disconnected"
          : (last?.status ?? "idle");
      this.state.error =
        last?.status === "inProgress"
          ? {
              code: "RECOVERY_INCOMPLETE",
              message:
                "The recovered turn has no terminal status. Its outcome is unknown; it is not running in this Synora process.",
            }
          : last?.error
            ? { code: "TURN_FAILED", message: last.error.message }
            : null;
      this.publish();
      return this.snapshot();
    } catch (error) {
      if (!this.cancelled) this.failed(error);
      if (this.transport) {
        const prior = this.transport;
        this.transport = undefined;
        await prior.close();
      }
      if (this.cancelled) return this.snapshot();
      throw error;
    } finally {
      this.starting = false;
    }
  }
  private priorUsage(conversationId: string, context: LiveContext) {
    const history = context.usageHistory ??
      (this.state.conversationId === conversationId ? this.state.usage : undefined);
    return history?.threadId === context.binding?.threadId ? history : undefined;
  }
  private begin(conversationId: string, requireBinding = false): LiveContext {
    if (this.disposed) throw new Error("Engine is closed");
    if (this.cancellation)
      throw new Error("Wait for cancellation cleanup to finish");
    if (this.starting || ["running", "waiting"].includes(this.state.status))
      throw new Error("A Synora turn is already active");
    const context = this.options.context(conversationId);
    this.validateBinding(context);
    const history = this.priorUsage(conversationId, context);
    this.usageBaseline = history?.value.total ?? (!context.binding ? emptyUsage() : undefined);
    if (requireBinding && !context.binding)
      throw Error("Start a live conversation before compacting its context");
    this.starting = true;
    this.cancelled = false;
    this.agents.clear();
    this.agentEpoch++;
    this.agentRefreshes.clear();
    this.agentRefreshAgain.clear();
    for (const agent of context.agentHistory ?? [])
      if (!agent.simulated && agent.parentId === context.binding?.threadId)
        this.agents.set(agent.id, structuredClone(agent));
    this.earlyAgentMetrics = [];
    this.childTurns.clear();
    this.pending.clear();
    this.userQuestions.clear();
    this.state = {
      ...this.state,
      conversationId,
      threadId: null,
      sessionId: undefined,
      turnId: null,
      status: "running",
      items: [],
      agents: [...this.agents.values()],
      approval: null,
      questions: [],
      error: null,
      firstDeltaAt: undefined,
      startedAt: Date.now(),
      completedAt: undefined,
      tokenUsage: history?.value,
      usage: history,
      backendRequests: [],
      compactions: context.compactionHistory ?? [],
    };
    this.publish();
    return context;
  }
  private armDeadline() {
    clearTimeout(this.deadline);
    const epoch = ++this.deadlineEpoch;
    if (["running", "waiting"].includes(this.state.status))
      this.deadline = setTimeout(() => { void this.expireDeadline(epoch); },
        this.options.turnDeadlineMs ?? this.options.turnIdleTimeoutMs ?? 600000);
  }
  private async expireDeadline(epoch: number) {
    const { threadId, turnId, sessionId } = this.state;
    const same = () => !this.disposed && !this.cancelled && !this.cancellation &&
      epoch === this.deadlineEpoch && this.state.threadId === threadId && this.state.turnId === turnId &&
      ["running", "waiting"].includes(this.state.status);
    if (!same()) return;
    if (this.options.turnDeadlineMs === undefined && sessionId && this.hasUpstreamProgress) {
      let progressing = false;
      const owned = new Set([sessionId]);
      for (const agent of this.agents.values())
        if (agent.parentId === threadId && agent.turnId && !agent.closed && !agent.metadataError && agent.status === "running") {
          owned.add(agent.id);
          if (agent.coreSessionId) owned.add(agent.coreSessionId);
        }
      for (const id of owned) {
        try { progressing = await this.hasUpstreamProgress(id); } catch { /* unknown is not verified progress */ }
        if (!same()) return;
        // A child can terminate while a status read is pending.
        const stillOwned = id === sessionId || [...this.agents.values()].some(a =>
          a.parentId === threadId && a.turnId && !a.closed && !a.metadataError && a.status === "running" &&
          (a.id === id || a.coreSessionId === id));
        if (progressing && stillOwned) break;
        progressing = false;
      }
      if (!same()) return;
      if (progressing) { this.armDeadline(); return; }
    }
    try {
      await this.cancel();
      if (this.disposed || epoch !== this.deadlineEpoch || this.state.threadId !== threadId || this.state.turnId !== turnId) return;
      this.failed(new AppServerError("TURN_DEADLINE", this.options.turnDeadlineMs !== undefined
        ? "The live operation exceeded its configured deadline and was interrupted"
        : "No progress could be verified within the live operation's idle budget; the owned turn was interrupted"));
    } catch (error) {
      if (!this.disposed && epoch === this.deadlineEpoch && this.state.threadId === threadId && this.state.turnId === turnId) this.failed(error);
    }
  }
  async compact(conversationId: string): Promise<EngineSnapshot> {
    const context = this.begin(conversationId, true);
    try {
      await this.attach(conversationId, context);
      parseResponse(
        "compact",
        await this.transport!.request("thread/compact/start", {
          threadId: this.state.threadId,
        }),
      );
      this.armDeadline();
      return this.snapshot();
    } catch (error) {
      if (!this.cancelled) this.failed(error);
      const prior = this.transport;
      this.transport = undefined;
      await prior?.close();
      if (this.cancelled) return this.snapshot();
      throw error;
    } finally {
      this.starting = false;
    }
  }
  async start(
    conversationId: string,
    text: string,
    _scenario: Scenario,
    images: Array<{ type: "localImage"; path: string }> = [],
  ): Promise<EngineSnapshot> {
    const context = this.begin(conversationId);
    try {
      await this.attach(conversationId, context);
      if (images.length) {
        const model = this.state.modelCatalog?.find(
          (m) => m.id === this.options.model,
        );
        const modalities =
          model?.providerModel?.inputModalities ??
          model?.coreModel?.inputModalities ??
          model?.input_modalities;
        if (!modalities?.includes("image"))
          throw new AppServerError(
            "MODEL_IMAGE_UNSUPPORTED",
            "The selected model does not advertise image input; attachments were kept in the draft",
          );
      }
      const turnParams = {
        threadId: this.state.threadId,
        input: [...(text.trim() ? [{ type: "text", text }] : []), ...images],
        ...(context.profile ? { effort: context.profile } : {}),
        collaborationMode: {
          mode: context.mode ?? "default",
          settings: {
            model: this.options.model,
            reasoning_effort: context.profile || null,
            developer_instructions: null,
          },
        },
      };
      validateTurnStart(turnParams);
      const turn = parseResponse(
        "turn",
        await this.transport!.request("turn/start", turnParams),
      );
      if (!this.state.turnId) this.state.turnId = turn.turn.id;
      this.armDeadline();
      return this.snapshot();
    } catch (error) {
      if (!this.cancelled) this.failed(error);
      if (this.transport) {
        const prior = this.transport;
        this.transport = undefined;
        await prior.close();
      }
      if (this.cancelled) return this.snapshot();
      throw error;
    } finally {
      this.starting = false;
    }
  }
  async steer(conversationId: string, text: string, expected: BusySubmission): Promise<EngineSnapshot> {
    const transport = this.transport, sessionId = this.state.sessionId;
    if (this.disposed || this.starting || this.cancelled || this.cancellation || this.state.cleanupPending || !transport ||
      this.state.connection !== "live" || this.state.conversationId !== conversationId ||
      this.state.threadId !== expected.expectedThreadId || this.state.turnId !== expected.expectedTurnId ||
      !["running", "waiting"].includes(this.state.status))
      throw Error("The active turn changed or is cancelling. The message was not steered.");
    if (!text.trim() || text.length > 100000) throw Error("Enter a text message");
    const params: import("../protocol/codex-0.153.4/v2/TurnSteerParams").TurnSteerParams = {
      threadId: expected.expectedThreadId,
      expectedTurnId: expected.expectedTurnId,
      clientUserMessageId: randomUUID(),
      input: [{ type: "text", text, text_elements: [] }],
    };
    const response = z.object({ turnId: z.string().min(1) }).parse(await transport.request("turn/steer", params));
    if (response.turnId !== expected.expectedTurnId)
      throw Error("Core returned a different steer turn identity. Review history before retrying.");
    if (this.disposed || this.cancelled || this.cancellation || this.state.cleanupPending || this.transport !== transport ||
      this.state.sessionId !== sessionId || this.state.turnId !== expected.expectedTurnId || this.state.threadId !== expected.expectedThreadId)
      throw Error("The turn changed while Core acknowledged the steer. Review history before retrying; the message was not replayed.");
    return this.snapshot();
  }
  private waitTerminal(timeoutMs: number): Promise<void> {
    if (!["running", "waiting"].includes(this.state.status))
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.terminalListeners.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.terminalListeners.delete(done);
        reject(new Error("App Server did not acknowledge turn interruption"));
      }, timeoutMs);
      this.terminalListeners.add(done);
    });
  }
  cancel(): Promise<EngineSnapshot> {
    if (this.cancellation) return this.cancellation;
    if (["running", "waiting"].includes(this.state.status)) {
      this.state.cleanupPending = true;
      this.publish();
    }
    const pending = this.cancelOwnedTurn()
      .finally(() => {
        if (this.cancellation === pending) this.cancellation = undefined;
        if (this.state.cleanupPending) {
          this.state.cleanupPending = false;
          this.publish();
        }
      })
      .then(() => this.snapshot());
    this.cancellation = pending;
    return pending;
  }
  private async cancelOwnedTurn(): Promise<EngineSnapshot> {
    for (const call of this.hostCalls)
      call.abort(new Error("Owning turn cancelled"));
    clearTimeout(this.deadline);
    if (!["running", "waiting"].includes(this.state.status))
      return this.snapshot();
    if (!this.state.turnId) {
      this.cancelled = true;
      const prior = this.transport;
      this.transport = undefined;
      await prior?.close();
      this.state.status = "interrupted";
      this.state.completedAt = Date.now();
      this.state.connection = "disconnected";
      this.publish();
      return this.snapshot();
    }
    try {
      const transport = this.transport!;
      const threadId = this.state.threadId!,
        turnId = this.state.turnId!;
      const deadline = performance.now() + 15000;
      const remaining = () => {
        const ms = Math.ceil(deadline - performance.now());
        if (ms <= 0)
          throw Error("App Server cancellation exceeded its deadline");
        return ms;
      };
      await transport.request(
        "turn/interrupt",
        { threadId, turnId },
        remaining(),
      );
      await this.waitTerminal(remaining());
      await cancelTurnTerminals(
        transport,
        threadId,
        () => {
          if (this.state.threadId !== threadId || this.state.turnId !== turnId)
            throw Error("Turn identity changed during cancellation cleanup");
          return this.state.items;
        },
        deadline,
      );
      // Original Core can acknowledge interruption while its quiet HTTP response
      // pump remains alive, including the native Axiom provider. Release this
      // owned process and its bridge for every provider, only after terminal/tool
      // cleanup. The next turn resumes the original durable thread/session.
      const prior = this.transport;
      this.transport = undefined;
      await prior?.close();
      this.state.connection = "disconnected";
      this.publish();
    } catch (error) {
      this.failed(error);
      if (this.transport) {
        const prior = this.transport;
        this.transport = undefined;
        await prior.close();
      }
      this.state.connection = "disconnected";
      this.publish();
      throw error;
    }
    return this.snapshot();
  }
  approve(id: string, approved: boolean): EngineSnapshot {
    const request = this.pending.get(id);
    if (!request) throw new Error("Approval is stale or does not exist");
    const parsed = parseServerRequest(request);
    if (
      parsed.method === "item/commandExecution/requestApproval" &&
      !commandDecisionAllowed(parsed.params, approved ? "accept" : "decline")
    )
      throw Error(
        "Core did not offer this approval decision. Cancel the turn if no suitable decision is available.",
      );
    if (parsed.method === "mcpServer/elicitation/request") {
      if (!isMcpToolApproval(parsed.params)) throw Error("Unsupported MCP approval form");
      this.transport!.respond(request.id, {
        result: { action: approved ? "accept" : "decline", content: approved ? {} : null, _meta: null },
      });
    } else if (parsed.method === "item/permissions/requestApproval") {
      const p = parsed.params.permissions;
      this.transport!.respond(request.id, {
        result: {
          permissions: approved
            ? {
                ...(p.network ? { network: p.network } : {}),
                ...(p.fileSystem ? { fileSystem: p.fileSystem } : {}),
              }
            : {},
          scope: "turn",
        },
      });
    } else
      this.transport!.respond(request.id, {
        result: { decision: approved ? "accept" : "decline" },
      });
    this.pending.delete(id);
    this.refreshRequests();
    return this.snapshot();
  }
  answer(id: string, answers: Record<string, string[]>) {
    const request = this.userQuestions.get(id);
    if (!request)
      throw new Error(
        "This user question has already been resolved or is stale",
      );
    const questions = request.params.questions;
    if (
      Object.keys(answers).length !== questions.length ||
      Object.keys(answers).some((k) => !questions.some((q) => q.id === k))
    )
      throw new Error("Answer exactly the pending question IDs");
    for (const q of questions) {
      const answer = answers[q.id];
      if (
        !Array.isArray(answer) ||
        !answer.length ||
        answer.some((v) => typeof v !== "string" || !v.trim())
      )
        throw new Error("Provide an answer to every pending question");
      if (
        q.options &&
        !q.isOther &&
        answer.some((v) => !q.options!.some((o) => o.label === v))
      )
        throw new Error("Select one of the offered answers");
    }
    this.transport!.respond(request.id, {
      result: {
        answers: Object.fromEntries(
          Object.entries(answers).map(([k, answers]) => [k, { answers }]),
        ),
      },
    });
    this.userQuestions.delete(id);
    this.refreshRequests();
    return this.snapshot();
  }
  async reconnect(after: number) {
    if (this.options.persistent) {
      await this.maintenanceJob;
      if (
        !this.transport ||
        this.transport.diagnostics.closed ||
        !this.transportKey
      )
        await this.keepConnected();
    } else if (
      (!this.transport || this.transport.diagnostics.closed) &&
      this.state.conversationId
    )
      await this.restore(this.state.conversationId);
    return {
      snapshot: this.snapshot(),
      events: this.log.filter((e) => e.sequence > after),
    };
  }
  async dispose() {
    if (this.ending) return this.ending;
    this.disposed = true;
    clearTimeout(this.maintenanceTimer);
    this.ending = (async () => {
      clearTimeout(this.deadline);
      try {
        await this.cancel();
      } finally {
        this.disposed = true;
        const prior = this.transport;
        this.transport = undefined;
        await prior?.close();
        await this.connectionJob?.catch(() => {});
        await this.maintenanceJob?.catch(() => {});
      }
    })();
    return this.ending;
  }
}
