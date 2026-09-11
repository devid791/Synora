import { randomUUID, createHash } from "node:crypto";
import { AppServerTransport, AppServerError } from "./app-server-transport";
import { parseResponse } from "./protocol-validation";
import {
  pluginChangeReason,
  type CorePluginSnapshot,
  type CorePluginTarget,
  type PluginAction,
} from "../shared/core-plugin";
import type { PluginDetail } from "../protocol/codex-0.153.4/v2/PluginDetail";
import type { prepareAxiomProcess } from "./axiom-process";
type Prepared = Awaited<ReturnType<typeof prepareAxiomProcess>>;
type Wire = Pick<
  AppServerTransport,
  "request" | "notify" | "respond" | "close"
>;
class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const digest = (detail: PluginDetail) =>
  createHash("sha256").update(JSON.stringify(detail)).digest("hex");

/** Explicit original Core plugin operations, never a renderer-selected RPC/path. */
export class CorePluginManager {
  private current: CorePluginSnapshot | null = null;
  private operation?: Promise<CorePluginSnapshot>;
  private transport?: Wire;
  constructor(
    private create: (
      o: ConstructorParameters<typeof AppServerTransport>[0],
    ) => Wire = (o) => new AppServerTransport(o),
    private deadlineMs = 60000,
  ) {}
  get busy() {
    return !!this.operation || !!this.current?.cleanupFailed;
  }
  snapshot() {
    return structuredClone(this.current);
  }
  reviewTarget(id: string) {
    const s = this.current;
    if (
      this.busy ||
      !s ||
      s.id !== id ||
      s.phase !== "completed" ||
      !s.detail ||
      s.cancelled
    )
      throw new PluginError(
        "PLUGIN_REVIEW_REQUIRED",
        "Inspect the current plugin before changing its installation.",
      );
    return structuredClone(s.target);
  }
  changeTarget(id: string, action: PluginAction, confirmed: boolean) {
    const target = this.reviewTarget(id);
    if (confirmed !== true)
      throw new PluginError(
        "PLUGIN_CONFIRMATION_REQUIRED",
        "Explicit confirmation is required for this plugin change.",
      );
    const reason = pluginChangeReason(this.current!.detail!, action);
    if (reason) throw new PluginError("PLUGIN_POLICY", reason);
    return target;
  }
  inspect(target: CorePluginTarget, prepare: () => Promise<Prepared>) {
    return this.begin(target, "inspect", prepare);
  }
  change(
    id: string,
    action: PluginAction,
    confirmed: boolean,
    prepare: () => Promise<Prepared>,
  ) {
    const target = this.changeTarget(id, action, confirmed);
    const reviewed = this.current!.detail!;
    return this.begin(
      target,
      action,
      prepare,
      digest(reviewed),
      reviewed.mcpServers,
    );
  }
  private begin(
    target: CorePluginTarget,
    action: CorePluginSnapshot["action"],
    prepare: () => Promise<Prepared>,
    reviewed?: string,
    mcpServers: string[] = [],
  ) {
    if (this.busy)
      throw new PluginError(
        "PLUGIN_BUSY",
        "Wait for the current plugin operation and owned cleanup.",
      );
    const state: CorePluginSnapshot = {
      id: randomUUID(),
      target: structuredClone(target),
      action,
      phase: "preparing",
      startedAt: Date.now(),
      busy: true,
      cancelled: false,
      mutationSent: false,
      detail: null,
      installResult: null,
    };
    this.current = state;
    const pending = this.run(state, prepare, reviewed, mcpServers).finally(
      () => {
        if (this.operation === pending) this.operation = undefined;
      },
    );
    this.operation = pending;
    return pending;
  }
  private async run(
    state: CorePluginSnapshot,
    prepare: () => Promise<Prepared>,
    reviewed?: string,
    mcpServers: string[] = [],
  ) {
    let prepared: Prepared | undefined;
    const end = Date.now() + this.deadlineMs;
    const request = async (
      method: string,
      params: unknown,
      mutates = false,
    ) => {
      if (state.cancelled)
        throw new PluginError(
          "PLUGIN_CANCELLED",
          "The owned plugin operation was cancelled.",
        );
      const remaining = end - Date.now();
      if (remaining <= 0)
        throw new PluginError(
          "PLUGIN_DEADLINE",
          "The plugin operation exceeded its deadline.",
        );
      if (mutates) state.mutationSent = true;
      return this.transport!.request(
        method,
        params,
        Math.min(30000, remaining),
      );
    };
    const params = {
      pluginName:
        state.target.marketplacePath === null
          ? state.target.remotePluginId
          : state.target.pluginName,
      ...(state.target.marketplacePath === null
        ? { remoteMarketplaceName: state.target.marketplaceName }
        : { marketplacePath: state.target.marketplacePath }),
    };
    const read = async () => {
      const detail = parseResponse(
        "pluginDetail",
        await request("plugin/read", params),
      ).plugin;
      if (
        detail.summary.id !== state.target.pluginId ||
        detail.summary.remotePluginId !== state.target.remotePluginId ||
        detail.summary.name !== state.target.pluginName ||
        detail.marketplaceName !== state.target.marketplaceName ||
        detail.marketplacePath !== state.target.marketplacePath
      )
        throw new PluginError(
          "PLUGIN_IDENTITY",
          "Core returned a different plugin or marketplace. No change is allowed.",
        );
      return detail;
    };
    try {
      if (state.action === "install" && state.target.discoveryOnly)
        throw new PluginError(
          "PLUGIN_ACCOUNT_REQUIRED",
          "This plugin is visible in the public directory but is not in this profile's account catalog. Connect the required account and refresh before installing. No installation was sent.",
        );
      if (state.target.marketplacePath === null && !state.target.remotePluginId)
        throw new PluginError(
          "PLUGIN_REMOTE_ID_REQUIRED",
          "Core did not provide the remote plugin identity required by this marketplace.",
        );
      prepared = await prepare();
      if (state.cancelled)
        throw new PluginError(
          "PLUGIN_CANCELLED",
          "Cancelled during preparation.",
        );
      // Core 0.153.4 plugin/install otherwise launches browser OAuth silently.
      // Original per-plugin MCP policy is restricted ONLY in this process:
      // it is not saved, never changes the bundle, and is absent from serving
      // and explicit sign-in processes. A fresh read still guards metadata drift.
      if (state.action === "install")
        prepared.args = [
          ...prepared.args,
          ...mcpServers.flatMap((name) => [
            "-c",
            `plugins.${JSON.stringify(state.target.pluginId)}.mcp_servers.${JSON.stringify(name)}.enabled=false`,
          ]),
        ];
      const wire = this.create({
        ...prepared,
        onNotification: () => {},
        onClose: () => {},
        onRequest: (r) =>
          wire.respond(r.id, {
            error: {
              code: -32601,
              message:
                "Plugin management cannot execute model tools or grant permissions",
            },
          }),
      });
      this.transport = wire;
      prepared = undefined;
      await request("initialize", {
        clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      wire.notify("initialized");
      state.phase = "reading";
      state.detail = await read();
      if (state.action !== "inspect") {
        if (digest(state.detail) !== reviewed)
          throw new PluginError(
            "PLUGIN_REVIEW_CHANGED",
            "Plugin metadata changed after review. Inspect it again before applying a change.",
          );
        const reason = pluginChangeReason(state.detail, state.action);
        if (reason) throw new PluginError("PLUGIN_POLICY", reason);
        state.phase = "changing";
        // Once dispatched, timeout/cancellation is not proof that nothing changed.
        if (state.action === "install")
          state.installResult = parseResponse(
            "pluginInstall",
            await request(
              "plugin/install",
              { ...params, installAttemptId: state.id },
              true,
            ),
          );
        else
          parseResponse(
            "pluginUninstall",
            await request(
              "plugin/uninstall",
              { pluginId: state.target.pluginId },
              true,
            ),
          );
        state.phase = "verifying";
        state.detail = await read();
        if (
          state.action === "install"
            ? !state.detail.summary.installed || !state.detail.summary.enabled
            : state.detail.summary.installed
        )
          throw new PluginError(
            "PLUGIN_POSTCONDITION",
            "Core did not confirm the requested installation state. Read the plugin again; do not retry the mutation blindly.",
          );
      }
      if (state.cancelled)
        throw new PluginError(
          "PLUGIN_CANCELLED",
          "Cancelled while reading the result.",
        );
      state.phase = "completed";
    } catch (e) {
      state.phase = state.mutationSent
        ? "uncertain"
        : state.cancelled
          ? "cancelled"
          : "failed";
      state.error = {
        code:
          e instanceof PluginError || e instanceof AppServerError
            ? String(e.code)
            : "PLUGIN_RESPONSE_INVALID",
        message:
          e instanceof PluginError
            ? e.message
            : e instanceof Error && e.message.startsWith("Invalid App Server ")
              ? e.message
              : "Core could not complete this plugin operation. Check the selected provider, marketplace access and connectivity, then inspect the current state.",
      };
    } finally {
      try {
        await this.transport?.close();
        await prepared?.cleanup?.();
      } catch {
        state.cleanupFailed = true;
        state.phase = "uncertain";
        state.error = {
          code: "PLUGIN_CLEANUP_FAILED",
          message:
            "Owned plugin cleanup failed. Restart Synora before another operation; no rollback is claimed.",
        };
      }
      this.transport = undefined;
      state.busy = !!state.cleanupFailed;
      state.completedAt = Date.now();
    }
    return structuredClone(state);
  }
  async cancel(id: string) {
    if (!this.current || this.current.id !== id)
      throw new PluginError(
        "PLUGIN_IDENTITY",
        "Plugin operation identity does not match.",
      );
    if (!this.operation) return this.snapshot();
    this.current.cancelled = true;
    try {
      await this.transport?.close();
    } catch {
      /* run owns the cleanup result */
    }
    await this.operation;
    return this.snapshot();
  }
  async dispose() {
    if (this.current && this.operation) await this.cancel(this.current.id);
  }
}
