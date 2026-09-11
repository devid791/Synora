import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PROTOCOL_VERSION } from "../shared/contracts";
import {
  accountLoginSchema,
  openAiAuthorizationUrl,
  type AccountLogin,
  type CoreAccountAttempt,
  type CoreAccountStatus,
} from "../shared/core-account";
import { appServerEnvironment } from "./axiom-process";
import { managedCore } from "./core-runtime";
import { validateBearer } from "./axiom-auth";
import {
  AppServerTransport,
  type TransportOptions,
  type RpcNotification,
} from "./app-server-transport";
import { parseResponse, parseNotification } from "./protocol-validation";
import type { AccountLoginCompletedNotification } from "../protocol/codex-0.153.4/v2/AccountLoginCompletedNotification";

type Transport = Pick<
  AppServerTransport,
  "request" | "notify" | "respond" | "close"
>;
type Options = {
  onAccount?: (account: CoreAccountStatus["account"]) => void;
  runtime?: import("./core-runtime").CoreSelection;
  stateDirectory: string;
  executable?: string;
  // Trusted host/test injection only; not exposed through IPC or web operations.
  transport?: (options: TransportOptions) => Transport;
  timeoutMs?: number;
};
type Operation = {
  transport?: Transport;
  close?: Promise<void>;
  stop?: Promise<void>;
  job?: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  ended: boolean;
  cancelled: boolean;
  attempt?: CoreAccountAttempt;
  completion?: AccountLoginCompletedNotification;
  changed: boolean;
  signal: () => void;
  wait: Promise<void>;
};
const failure = (message: string) => new Error(message);
const terminal = (v?: CoreAccountAttempt) =>
  !!v && ["authorized", "failed", "cancelled"].includes(v.status);

/** Account-only Core connection: no threads, workspace, models, tools or inference. */
export class CoreAccountController {
  private operation?: Operation;
  private lastAttempt: CoreAccountAttempt | null = null;
  private account: CoreAccountStatus["account"] = null;
  private observedAt: number | null = null;
  private disposed = false;
  private cleanupError?: string;
  constructor(private options: Options) {}
  get busy() {
    return !!this.operation || !!this.cleanupError;
  }
  snapshot(): CoreAccountStatus {
    return structuredClone({
      busy: this.busy,
      cleanupError: this.cleanupError,
      account: this.account,
      observedAt: this.observedAt,
      attempt: this.operation?.attempt ?? this.lastAttempt,
      storage: "core-private-file",
    });
  }
  private begin(): Operation {
    if (this.disposed) throw failure("Account service is closed");
    if (this.cleanupError) throw failure(this.cleanupError);
    if (this.busy)
      throw failure("Finish or cancel the pending account operation first");
    let signal!: () => void;
    const wait = new Promise<void>((r) => {
      signal = r;
    });
    const op: Operation = {
      ended: false,
      cancelled: false,
      changed: false,
      signal,
      wait,
    };
    this.operation = op;
    return op;
  }
  private close(op: Operation) {
    return (op.close ??= op.transport?.close() ?? Promise.resolve());
  }
  private async finish(op: Operation) {
    clearTimeout(op.timer);
    op.ended = true;
    try {
      await op.stop;
      await this.close(op);
    } catch {
      this.cleanupError =
        "Could not confirm closure of the owned account process. Restart Synora before another account operation; no replacement process was started.";
      if (op.attempt)
        op.attempt = {
          ...op.attempt,
          status: "failed",
          code: "ACCOUNT_CLEANUP_FAILED",
          message: this.cleanupError,
          authorizationUrl: undefined,
          userCode: undefined,
        };
    } finally {
      if (op.attempt) this.lastAttempt = { ...op.attempt };
      if (this.operation === op) this.operation = undefined;
    }
  }
  private stop(
    op: Operation,
    status: "cancelled" | "failed",
    code: string,
    message: string,
  ) {
    if (op.stop || op.ended || terminal(op.attempt))
      return op.stop ?? Promise.resolve();
    op.cancelled = true;
    if (op.attempt)
      op.attempt = {
        ...op.attempt,
        status,
        code,
        message,
        authorizationUrl: undefined,
        userCode: undefined,
      };
    op.signal();
    op.stop = (async () => {
      try {
        if (op.transport && op.attempt?.loginId) {
          parseResponse(
            "accountCancel",
            await op.transport.request(
              "account/login/cancel",
              { loginId: op.attempt.loginId },
              3000,
            ),
          );
        }
      } catch {
        // Closing the owned process also closes its listener; never claim grant revocation.
      } finally {
        await this.close(op);
      }
    })();
    void op.stop.catch(() => {});
    return op.stop;
  }
  private async connect(op: Operation) {
    const cwd = resolve(this.options.stateDirectory);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (op.cancelled) throw failure("Account operation cancelled");
    const executable =
      this.options.executable ??
      (await (this.options.runtime?.executable() ?? managedCore(cwd)));
    const env = appServerEnvironment(cwd);
    if (!this.options.transport) {
      const version = await promisify(execFile)(executable, ["--version"], {
        cwd,
        env,
        timeout: 10000,
        maxBuffer: 65536,
        windowsHide: true,
      });
      if (
        version.stdout.trim() !==
        `codex-cli ${this.options.runtime?.version ?? PROTOCOL_VERSION}`
      )
        throw failure("Pinned Core version mismatch");
    }
    if (op.cancelled) throw failure("Account operation cancelled");
    const config = {
      model_provider: "openai",
      cli_auth_credentials_store: "file",
      mcp_oauth_credentials_store: "file",
      "analytics.enabled": false,
      "feedback.enabled": false,
      // The account connection never installs plugins, mounts tools or syncs app catalogs.
      "features.plugins": false,
      "features.apps": false,
    };
    const transport = (
      this.options.transport ?? ((o) => new AppServerTransport(o))
    )({
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
      requestTimeoutMs: 30000,
      onNotification: (n) => this.notification(op, n),
      onRequest: (r) =>
        transport.respond(r.id, {
          error: {
            code: -32601,
            message:
              "Account-only connection cannot execute tools or exchange externally managed tokens",
          },
        }),
      onClose: () => {
        if (op.ended || op.cancelled || terminal(op.attempt)) return;
        void this.stop(
          op,
          "failed",
          "ACCOUNT_PROCESS_CLOSED",
          "The owned account process closed before completion. Refresh account status before retrying.",
        );
      },
    });
    op.transport = transport;
    await transport.request("initialize", {
      clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if (op.cancelled) throw failure("Account operation cancelled");
    transport.notify("initialized");
    return transport;
  }
  private notification(op: Operation, raw: RpcNotification) {
    if (
      op.ended ||
      op.cancelled ||
      !op.attempt ||
      !["account/login/completed", "account/updated"].includes(raw.method)
    )
      return;
    try {
      const n = parseNotification(raw);
      if (n.method === "account/login/completed") {
        if (
          op.completion &&
          JSON.stringify(op.completion) !== JSON.stringify(n.params)
        )
          throw failure("Conflicting completion");
        op.completion = n.params;
      } else if (n.method === "account/updated") op.changed = true;
      this.signalCompletion(op);
    } catch {
      void this.stop(
        op,
        "failed",
        "ACCOUNT_INVALID_EVENT",
        "Core returned an invalid or conflicting account event.",
      );
    }
  }
  private signalCompletion(op: Operation) {
    if (!op.completion) return;
    if (
      op.attempt?.loginId !== undefined &&
      (op.completion.loginId ?? null) !== op.attempt.loginId
    ) {
      void this.stop(
        op,
        "failed",
        "ACCOUNT_IDENTITY_MISMATCH",
        "Core returned a different sign-in identity.",
      );
    } else if (!op.completion.success || op.changed) op.signal();
  }
  login(raw: AccountLogin) {
    const login = accountLoginSchema.parse(raw);
    if (login.type === "apiKey") login.apiKey = validateBearer(login.apiKey);
    const op = this.begin();
    const timeout = this.options.timeoutMs ?? 180000;
    op.attempt = {
      id: randomUUID(),
      mode: login.type,
      status: "starting",
      expiresAt: Date.now() + timeout,
    };
    op.timer = setTimeout(() => {
      void this.stop(
        op,
        "failed",
        "ACCOUNT_DEADLINE",
        "Sign-in did not complete before its deadline. The owned process was closed; refresh account status before retrying.",
      );
    }, timeout);
    op.job = this.runLogin(op, login)
      .catch(() => {
        if (!op.cancelled) {
          op.attempt = {
            ...op.attempt!,
            status: "failed",
            code: "ACCOUNT_LOGIN_FAILED",
            message:
              "Core could not complete sign-in. Check your account and network, then retry. No inference access was assumed.",
            authorizationUrl: undefined,
            userCode: undefined,
          };
        }
      })
      .finally(() => this.finish(op));
    void op.job.catch(() => {});
    return this.snapshot();
  }
  private async runLogin(op: Operation, login: AccountLogin) {
    const transport = await this.connect(op);
    if (op.cancelled) return;
    let result;
    try {
      result = parseResponse(
        "accountLogin",
        await transport.request("account/login/start", login),
      );
    } finally {
      if (login.type === "apiKey") login.apiKey = "";
    }
    if (op.cancelled) return;
    if (result.type !== op.attempt!.mode)
      throw failure("Unexpected login mode");
    if (result.type === "chatgpt") {
      if (!result.loginId) throw failure("Missing login identity");
      op.attempt = {
        ...op.attempt!,
        loginId: result.loginId,
        status: "awaiting_browser",
        authorizationUrl: openAiAuthorizationUrl(result.authUrl),
      };
    } else if (result.type === "chatgptDeviceCode") {
      if (!result.loginId || !/^[A-Za-z0-9-]{1,80}$/.test(result.userCode))
        throw failure("Invalid device-code response");
      op.attempt = {
        ...op.attempt!,
        loginId: result.loginId,
        status: "awaiting_device",
        authorizationUrl: openAiAuthorizationUrl(result.verificationUrl),
        userCode: result.userCode,
      };
    } else op.attempt = { ...op.attempt!, loginId: null, status: "verifying" };
    this.signalCompletion(op);
    await op.wait;
    if (op.cancelled) return;
    const completed = op.completion;
    if (!completed || (completed.loginId ?? null) !== op.attempt.loginId) {
      op.attempt = {
        ...op.attempt,
        status: "failed",
        code: "ACCOUNT_IDENTITY_MISMATCH",
        message: "Core returned a different sign-in identity.",
        authorizationUrl: undefined,
        userCode: undefined,
      };
      return;
    }
    if (!completed.success) {
      op.attempt = {
        ...op.attempt,
        status: "failed",
        code: "ACCOUNT_REJECTED",
        message:
          "Core reported unsuccessful sign-in. No account access was assumed.",
        authorizationUrl: undefined,
        userCode: undefined,
      };
      return;
    }
    op.attempt = {
      ...op.attempt,
      status: "verifying",
      authorizationUrl: undefined,
      userCode: undefined,
    };
    const account = parseResponse(
      "account",
      await transport.request("account/read", { refreshToken: false }),
    );
    if (op.cancelled) return;
    if (
      account.account?.type !== (login.type === "apiKey" ? "apiKey" : "chatgpt")
    )
      throw failure("Account not recognized after login");
    this.account = account;
    this.observedAt = Date.now();
    this.options.onAccount?.(account);
    op.attempt = { ...op.attempt, status: "authorized" };
  }
  url(id: string) {
    const attempt = this.operation?.attempt;
    if (
      !attempt ||
      attempt.id !== id ||
      !attempt.authorizationUrl ||
      !["awaiting_browser", "awaiting_device"].includes(attempt.status) ||
      Date.now() >= attempt.expiresAt
    )
      throw failure("No matching pending OpenAI sign-in");
    return openAiAuthorizationUrl(attempt.authorizationUrl);
  }
  async cancel(id: string) {
    const op = this.operation;
    if (!op?.attempt || op.attempt.id !== id)
      throw failure("Stale OpenAI sign-in identity");
    await this.stop(
      op,
      "cancelled",
      "ACCOUNT_CANCELLED",
      "Stopped the owned sign-in attempt. This does not revoke permissions already granted; refresh account status if consent completed at the same time.",
    ).catch(() => {}); // finish() exposes a sanitized cleanup failure in status.
    await op.job;
    return this.snapshot();
  }
  private async inspect(logout: boolean) {
    const op = this.begin();
    op.timer = setTimeout(() => {
      void this.stop(
        op,
        "failed",
        "ACCOUNT_DEADLINE",
        "Account operation timed out",
      );
    }, 45000);
    op.job = (async () => {
      try {
        const t = await this.connect(op);
        if (op.cancelled) throw failure("Cancelled");
        if (logout)
          parseResponse(
            "accountLogout",
            await t.request("account/logout", undefined),
          );
        const account = parseResponse(
          "account",
          await t.request("account/read", { refreshToken: false }),
        );
        if (op.cancelled || (logout && account.account !== null))
          throw failure("Account state not confirmed");
        this.account = account;
        this.observedAt = Date.now();
        this.options.onAccount?.(account);
        if (logout) this.lastAttempt = null;
      } catch {
        this.account = null;
        this.observedAt = null;
        throw failure(
          logout
            ? "Core could not confirm logout. Refresh account status and retry."
            : "Core could not read this Synora account. Check the owned runtime and retry.",
        );
      } finally {
        await this.finish(op);
      }
    })();
    await op.job;
    return this.snapshot();
  }
  read() {
    return this.inspect(false);
  }
  logout() {
    return this.inspect(true);
  }
  async dispose() {
    this.disposed = true;
    const op = this.operation;
    if (!op) return;
    await this.stop(
      op,
      "cancelled",
      "ACCOUNT_CLOSED",
      "Synora closed its account connection.",
    ).catch(() => {});
    await op.job?.catch(() => {});
  }
}
