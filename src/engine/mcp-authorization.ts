import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { appServerEnvironment } from "./axiom-process";
import { managedCore } from "./core-runtime";
import { mcpConfiguration } from "./mcp-config";
import { integrationServerName } from "../shared/integration-runtime";
import { oauthBrowserUrl } from "../shared/oauth-url";
import {
  configSchema,
  PROTOCOL_VERSION,
  type Integration,
  type McpAuthorization,
} from "../shared/contracts";
import {
  AppServerTransport,
  type TransportOptions,
} from "./app-server-transport";
import { parseNotification, parseResponse } from "./protocol-validation";
import type { ListMcpServerStatusResponse } from "../protocol/codex-0.153.4/v2/ListMcpServerStatusResponse";

type Transport = Pick<
  AppServerTransport,
  "request" | "notify" | "respond" | "close"
>;
type Options = {
  runtime?: import("./core-runtime").CoreSelection;
  integration: Integration;
  providerId: string;
  stateDirectory: string;
  executable?: string;
  // Host/test injection only: never renderer-supplied RPC or executable.
  timeoutMs?: number;
  transport?: (options: TransportOptions) => Transport;
};
type PluginOptions = {
  plugin: {
    id: string;
    name: string;
    marketplaceName: string;
    marketplacePath: string | null;
    serverName: string;
    remotePluginId?: string | null;
  };
  providerId: string;
  prepare: () => Promise<
    Pick<TransportOptions, "executable" | "cwd" | "env" | "args" | "cleanup">
  >;
  timeoutMs?: number;
  transport?: (options: TransportOptions) => Transport;
};
type Flow = {
  value: McpAuthorization;
  terminal: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  transport?: Transport;
  preparedCleanup?: () => Promise<void>;
  closed?: Promise<void>;
  run?: Promise<void>;
  resolve: () => void;
  completion: Promise<void>;
};

/** One explicitly requested OAuth operation. No model, thread or tool execution. */
export class McpAuthorizationController {
  private flow?: Flow;
  private disposed = false;
  constructor(private completed: () => void = () => {}) {}
  get busy() {
    return (
      !!this.flow && (!this.flow.settled || !!this.flow.value.cleanupFailed)
    );
  }
  snapshot(): McpAuthorization | null {
    return this.flow ? { ...this.flow.value, busy: this.busy } : null;
  }
  start(options: Options | PluginOptions): McpAuthorization {
    if (this.disposed) throw new Error("Authorization service is closed");
    if (this.busy)
      throw new Error("Finish or cancel the pending browser sign-in first");
    const integration =
      "integration" in options ? configSchema.parse(options.integration) : null;
    if (
      integration &&
      (!integration.enabled ||
        integration.kind !== "mcp" ||
        integration.executor !== "http-mcp" ||
        integration.auth !== "oauth")
    )
      throw new Error(
        "Select an enabled HTTP MCP integration configured for OAuth",
      );
    let done!: () => void;
    const completion = new Promise<void>((r) => {
      done = r;
    });
    const timeoutMs = options.timeoutMs ?? 180000;
    const flow: Flow = {
      value: {
        id: randomUUID(),
        integrationId: integration?.id ?? (options as PluginOptions).plugin.id,
        providerId: options.providerId,
        serverName: integration
          ? integrationServerName(integration.id)
          : (options as PluginOptions).plugin.serverName,
        ...("plugin" in options ? { pluginId: options.plugin.id } : {}),
        status: "starting",
        expiresAt: Date.now() + timeoutMs,
      },
      terminal: false,
      settled: false,
      resolve: done,
      completion,
    };
    this.flow = flow;
    flow.timer = setTimeout(
      () =>
        this.finish(
          flow,
          "failed",
          "OAUTH_DEADLINE",
          "Browser sign-in did not complete before its deadline. Retry when ready.",
        ),
      timeoutMs,
    );
    flow.run = this.run(
      flow,
      integration ? ({ ...options, integration } as Options) : options,
    )
      .catch(() => {
        // Core errors may contain URLs, codes or tokens. Never persist/echo them.
        this.finish(
          flow,
          "failed",
          "OAUTH_START_FAILED",
          "Core could not complete this OAuth operation. Check the configured MCP endpoint and its OAuth support.",
        );
      })
      .finally(async () => {
        try {
          await this.close(flow);
        } catch {
          flow.value = {
            ...flow.value,
            status: "failed",
            cleanupFailed: true,
            authorizationUrl: undefined,
            code: "OAUTH_CLEANUP_FAILED",
            message:
              "Owned sign-in cleanup failed. Restart Synora before another operation; no credential rollback is claimed.",
          };
        } finally {
          flow.settled = true;
        }
      });
    // Process cleanup is bounded by the transport. Consume rejection even if
    // the window is closed without polling or cancelling the finished flow.
    void flow.run.catch(() => {});
    return { ...flow.value, busy: this.busy };
  }
  private close(flow: Flow) {
    if (!flow.closed && (flow.transport || flow.preparedCleanup))
      flow.closed = Promise.resolve().then(() =>
        flow.transport ? flow.transport.close() : flow.preparedCleanup!(),
      );
    return flow.closed ?? Promise.resolve();
  }
  private finish(
    flow: Flow,
    status: "authorized" | "failed" | "cancelled",
    code?: string,
    message?: string,
  ) {
    if (flow.terminal) return;
    flow.terminal = true;
    clearTimeout(flow.timer);
    flow.value = {
      ...flow.value,
      status,
      code,
      message,
      authorizationUrl: undefined,
    };
    flow.resolve();
    void this.close(flow).catch(() => {});
    if (status === "authorized") this.completed();
  }
  url(id: string) {
    const f = this.flow;
    if (
      !f ||
      f.value.id !== id ||
      f.value.status !== "awaiting_browser" ||
      !f.value.authorizationUrl ||
      Date.now() >= f.value.expiresAt
    )
      throw new Error("No matching pending browser sign-in");
    return oauthBrowserUrl(f.value.authorizationUrl);
  }
  async cancel(id: string) {
    const f = this.flow;
    if (!f || f.value.id !== id)
      throw new Error("Stale browser sign-in identity");
    if (!f.terminal)
      this.finish(
        f,
        "cancelled",
        "OAUTH_CANCELLED",
        "Stopped waiting and closed the owned sign-in process. This does not revoke permissions already granted at the provider.",
      );
    await f.run;
    return { ...f.value, busy: this.busy };
  }
  async dispose() {
    this.disposed = true;
    if (this.flow) await this.cancel(this.flow.value.id);
  }
  private async prepareConfigured(
    options: Options,
  ): Promise<
    Pick<TransportOptions, "executable" | "cwd" | "env" | "args" | "cleanup">
  > {
    const cwd = resolve(options.stateDirectory);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const executable =
      options.executable ??
      (await (options.runtime?.executable() ?? managedCore(cwd)));
    const env = appServerEnvironment(cwd);
    if (!options.transport) {
      const version = await promisify(execFile)(executable, ["--version"], {
        cwd,
        env,
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      if (
        version.stdout.trim() !==
        `codex-cli ${options.runtime?.version ?? PROTOCOL_VERSION}`
      )
        throw new Error("Pinned Core version mismatch");
    }
    const config = {
      ...(await mcpConfiguration([options.integration], cwd)),
      "analytics.enabled": false,
      "feedback.enabled": false,
    };
    return {
      executable,
      cwd,
      env,
      args: [
        "app-server",
        "--stdio",
        ...Object.entries(config).flatMap(([k, v]) => [
          "-c",
          `${k}=${JSON.stringify(v)}`,
        ]),
      ],
    };
  }
  private async run(flow: Flow, options: Options | PluginOptions) {
    const prepared =
      "plugin" in options
        ? await options.prepare()
        : await this.prepareConfigured(options);
    // Preparation owns resources before a transport exists. Keep ownership on
    // the flow until construction succeeds, so cancellation/constructor failure
    // cannot swallow cleanup errors or report an idle, reusable controller.
    flow.preparedCleanup = prepared.cleanup;
    if (flow.terminal) return;
    const create =
      options.transport ?? ((o: TransportOptions) => new AppServerTransport(o));
    let transport: Transport;
    transport = create({
      ...prepared,
      requestTimeoutMs: 30000,
      onNotification: (raw) => {
        if (flow.terminal || raw.method !== "mcpServer/oauthLogin/completed")
          return;
        try {
          const n = parseNotification(raw);
          if (n.method !== "mcpServer/oauthLogin/completed") return;
          if (
            n.params.name !== flow.value.serverName ||
            n.params.threadId !== null
          ) {
            this.finish(
              flow,
              "failed",
              "OAUTH_IDENTITY_MISMATCH",
              "Core returned a different OAuth server or thread identity.",
            );
          } else if (n.params.success) this.finish(flow, "authorized");
          else
            this.finish(
              flow,
              "failed",
              "OAUTH_REJECTED",
              "Core reported unsuccessful sign-in. No connected tool state was assumed.",
            );
        } catch {
          this.finish(
            flow,
            "failed",
            "OAUTH_INVALID_EVENT",
            "Core returned a malformed OAuth completion event.",
          );
        }
      },
      onRequest: (r) =>
        transport.respond(r.id, {
          error: {
            code: -32601,
            message: "This authorization connection cannot execute model tools",
          },
        }),
      onClose: () =>
        this.finish(
          flow,
          "failed",
          "OAUTH_PROCESS_CLOSED",
          "The owned sign-in process closed before completion.",
        ),
    });
    flow.transport = transport;
    flow.preparedCleanup = undefined;
    if (flow.terminal) return;
    await transport.request("initialize", {
      clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if (flow.terminal) return;
    transport.notify("initialized");
    if ("plugin" in options) {
      const p = options.plugin;
      const detail = parseResponse(
        "pluginDetail",
        await transport.request("plugin/read", {
          pluginName: p.marketplacePath === null ? p.remotePluginId : p.name,
          ...(p.marketplacePath === null
            ? { remoteMarketplaceName: p.marketplaceName }
            : { marketplacePath: p.marketplacePath }),
        }),
      ).plugin;
      if (flow.terminal) return;
      if (
        detail.summary.id !== p.id ||
        detail.summary.remotePluginId !== (p.remotePluginId ?? null) ||
        detail.summary.name !== p.name ||
        detail.marketplaceName !== p.marketplaceName ||
        detail.marketplacePath !== p.marketplacePath ||
        !detail.summary.installed ||
        !detail.summary.enabled ||
        !detail.mcpServers.includes(p.serverName)
      )
        throw Error("Plugin authorization identity or installation changed");
      let cursor: string | null = null,
        matches = 0;
      const cursors = new Set<string>();
      do {
        if (flow.terminal) return;
        const page: ListMcpServerStatusResponse = parseResponse(
          "mcp",
          await transport.request("mcpServerStatus/list", {
            cursor,
            limit: 100,
            detail: "toolsAndAuthOnly",
          }),
        );
        matches += page.data.filter(
          (s) => s.name === p.serverName && s.pluginId === p.id,
        ).length;
        cursor = page.nextCursor;
        if (cursor !== null && cursors.has(cursor))
          throw Error("Ambiguous plugin MCP inventory cursor");
        if (cursor !== null) cursors.add(cursor);
      } while (cursor !== null);
      if (matches !== 1)
        throw Error(
          "Plugin server does not have an unambiguous original Core runtime identity",
        );
    }
    const result = parseResponse(
      "oauth",
      await transport.request("mcpServer/oauth/login", {
        name: flow.value.serverName,
        timeoutSecs: Math.max(
          1,
          Math.ceil((flow.value.expiresAt - Date.now()) / 1000),
        ),
      }),
    );
    // Terminal events can legitimately race the RPC response. Never regress them.
    if (flow.terminal) return;
    flow.value = {
      ...flow.value,
      status: "awaiting_browser",
      authorizationUrl: oauthBrowserUrl(result.authorizationUrl),
    };
    await flow.completion;
  }
}
