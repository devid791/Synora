import { randomUUID } from "node:crypto";
import type {
  EngineSnapshot,
  EventEnvelope,
  EngineEvent,
  Scenario,
  AgentRecord,
} from "../shared/contracts";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
import type { Turn } from "../protocol/codex-0.153.4/v2/Turn";

export interface EngineAdapter {
  readonly mode: "simulated";
  start(threadId: string, text: string, scenario: Scenario): EngineSnapshot;
  cancel(): EngineSnapshot;
  approve(id: string, approved: boolean): EngineSnapshot;
  snapshot(): EngineSnapshot;
  reconnect(after: number): {
    snapshot: EngineSnapshot;
    events: EventEnvelope[];
  };
  dispose(): void;
}
export class Simulator implements EngineAdapter {
  readonly mode = "simulated" as const;
  private state: EngineSnapshot = {
    connection: "simulated",
    threadId: null,
    turnId: null,
    status: "idle",
    items: [],
    agents: [],
    approval: null,
    sequence: 0,
  };
  private log: EventEnvelope[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private started = 0;
  private pendingApproval: (() => void) | null = null;
  constructor(
    private sink: (envelope: EventEnvelope) => void,
    private speed = 1,
    private observe?: (envelope: EventEnvelope) => void,
    initialSequence = 0,
  ) {
    this.state.sequence = initialSequence;
  }
  snapshot() {
    return structuredClone(this.state);
  }
  private emit(event: EngineEvent) {
    const envelope: EventEnvelope = {
      sequence: ++this.state.sequence,
      at: Date.now(),
      simulated: true,
      event,
    };
    this.log.push(envelope);
    if (this.log.length > 2000) this.log.shift();
    this.observe?.(envelope);
    if (this.state.connection === "simulated") this.sink(envelope);
  }
  private schedule(delay: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.state.status === "running" || this.state.status === "waiting")
        fn();
    }, delay * this.speed);
    this.timers.add(timer);
  }
  private turn(status: Turn["status"]): Turn {
    return {
      id: this.state.turnId!,
      items: structuredClone(this.state.items),
      itemsView: "full",
      status,
      error:
        status === "failed"
          ? {
              message: "Simulated upstream failure. No model request was sent.",
              codexErrorInfo: null,
              additionalDetails: null,
              misalignment: null,
            }
          : null,
      startedAt: Math.floor(this.started / 1000),
      completedAt:
        status === "inProgress" ? null : Math.floor(Date.now() / 1000),
      durationMs: status === "inProgress" ? null : Date.now() - this.started,
    };
  }
  private item(item: ThreadItem, done = false) {
    const index = this.state.items.findIndex((v) => v.id === item.id);
    if (index >= 0) this.state.items[index] = structuredClone(item);
    else this.state.items.push(structuredClone(item));
    const threadId = this.state.threadId!,
      turnId = this.state.turnId!;
    this.emit(
      done
        ? {
            kind: "protocol",
            payload: {
              method: "item/completed",
              params: { item, threadId, turnId, completedAtMs: Date.now() },
            },
          }
        : {
            kind: "protocol",
            payload: {
              method: "item/started",
              params: { item, threadId, turnId, startedAtMs: Date.now() },
            },
          },
    );
  }
  private finish(status: "completed" | "failed" | "interrupted") {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.state.status = status;
    this.state.approval = null;
    this.pendingApproval = null;
    this.state.agents = this.state.agents.map((a) =>
      a.status === "running"
        ? { ...a, status: status === "completed" ? "completed" : "interrupted" }
        : a,
    );
    this.emit({ kind: "agents", agents: this.state.agents });
    this.emit({
      kind: "protocol",
      payload: {
        method: "turn/completed",
        params: { threadId: this.state.threadId!, turn: this.turn(status) },
      },
    });
  }
  private reply(text: string) {
    const id = randomUUID();
    let value = "";
    const item: Extract<ThreadItem, { type: "agentMessage" }> = {
      type: "agentMessage",
      id,
      text: "",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    this.item(item);
    const chunks = text.match(/.{1,18}/gs) ?? [];
    chunks.forEach((delta, i) =>
      this.schedule(80 * (i + 1), () => {
        value += delta;
        this.state.items = this.state.items.map((v) =>
          v.id === id ? { ...item, text: value } : v,
        );
        this.emit({
          kind: "protocol",
          payload: {
            method: "item/agentMessage/delta",
            params: {
              threadId: this.state.threadId!,
              turnId: this.state.turnId!,
              itemId: id,
              delta,
            },
          },
        });
        if (i === chunks.length - 1) {
          this.item({ ...item, text: value }, true);
          this.finish("completed");
        }
      }),
    );
  }
  start(threadId: string, text: string, scenario: Scenario) {
    if (["running", "waiting"].includes(this.state.status))
      throw new Error("A simulated turn is already active");
    if (this.state.connection === "disconnected")
      throw new Error("Reconnect the simulated engine first");
    this.state = {
      ...this.state,
      threadId,
      turnId: randomUUID(),
      status: "running",
      items: [],
      agents: [],
      approval: null,
    };
    this.started = Date.now();
    this.emit({
      kind: "protocol",
      payload: {
        method: "turn/started",
        params: { threadId, turn: this.turn("inProgress") },
      },
    });
    this.item(
      {
        type: "userMessage",
        id: randomUUID(),
        clientId: null,
        content: [{ type: "text", text, text_elements: [] }],
      },
      true,
    );
    if (scenario === "failure") {
      this.schedule(350, () => this.finish("failed"));
      return this.snapshot();
    }
    if (scenario === "approval") {
      const id = randomUUID();
      const params = {
        kind: "command" as const,
        threadId,
        turnId: this.state.turnId!,
        itemId: randomUUID(),
        startedAtMs: Date.now(),
        environmentId: null,
        command: 'printf "Simulated approval only"',
        cwd: null,
        reason: "Simulator fixture: this command is never executed.",
      };
      this.state.status = "waiting";
      this.state.approval = { id, params };
      this.pendingApproval = () =>
        this.reply(
          "Approval accepted in the simulator. No shell command was executed.",
        );
      this.emit({ kind: "approval", id, params });
      return this.snapshot();
    }
    if (scenario === "tool") {
      const item: Extract<ThreadItem, { type: "dynamicToolCall" }> = {
        type: "dynamicToolCall",
        id: randomUUID(),
        namespace: null,
        tool: "read_file",
        arguments: { path: "example.md" },
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      this.item(item);
      this.schedule(400, () => {
        this.item(
          {
            ...item,
            status: "completed",
            success: true,
            durationMs: 400,
            contentItems: [
              {
                type: "inputText",
                text: "Simulated file result; no file was read.",
              },
            ],
          },
          true,
        );
        this.reply(
          "The simulated read_file call completed with a matching item ID. Open the Files panel for real local file access.",
        );
      });
      return this.snapshot();
    }
    if (scenario === "agents") {
      this.state.agents = ["Astra", "Vega"].map(
        (name, i): AgentRecord => ({
          id: randomUUID(),
          name,
          parentId: threadId,
          task: i
            ? "Review the simulated result"
            : "Inspect a simulated workspace",
          status: "running",
          result: "",
          simulated: true,
        }),
      );
      this.emit({ kind: "agents", agents: this.state.agents });
      this.schedule(500, () => {
        this.state.agents = this.state.agents.map((a) => ({
          ...a,
          status: "completed",
          result: `${a.name}: simulated task complete; no external work performed.`,
        }));
        this.emit({ kind: "agents", agents: this.state.agents });
        this.reply(
          "Both simulated agents have completed. Their names, parent relationship and results are available in Agents.",
        );
      });
      return this.snapshot();
    }
    if (scenario === "disconnect") {
      this.schedule(100, () => {
        this.emit({ kind: "connection", state: "disconnected" });
        this.state.connection = "disconnected";
      });
      this.schedule(300, () =>
        this.reply(
          "This simulated turn completed during a disconnected transport. Reconciliation restores the authoritative final snapshot without duplicating text.",
        ),
      );
      return this.snapshot();
    }
    this.schedule(scenario === "slow" ? 8000 : 120, () =>
      this.reply(
        "Synora foundation is ready. This response is simulated; Axiom and external providers are not connected. Local files, terminal and browser are separate desktop services.",
      ),
    );
    return this.snapshot();
  }
  cancel() {
    if (["running", "waiting"].includes(this.state.status))
      this.finish("interrupted");
    return this.snapshot();
  }
  approve(id: string, approved: boolean) {
    if (this.state.approval?.id !== id || !this.pendingApproval)
      throw new Error("Approval is stale or does not exist");
    const next = this.pendingApproval;
    this.state.approval = null;
    this.pendingApproval = null;
    this.state.status = "running";
    if (approved) next();
    else this.finish("interrupted");
    return this.snapshot();
  }
  reconnect(after: number) {
    this.state.connection = "simulated";
    this.emit({ kind: "connection", state: "simulated" });
    return {
      snapshot: this.snapshot(),
      events: this.log.filter((e) => e.sequence > after),
    };
  }
  dispose() {
    this.cancel();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
