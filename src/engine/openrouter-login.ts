import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderLoginStatus } from "../shared/provider-login";
import { validateBearer } from "./axiom-auth";

// Official supported PKCE flow, NOT credentials borrowed from another client:
// https://openrouter.ai/docs/guides/overview/auth/oauth
const endpoint = "https://openrouter.ai/api/v1";
type Exchange = (
  code: string,
  verifier: string,
  signal: AbortSignal,
) => Promise<string>;

export async function exchangeOpenRouterKey(
  code: string,
  verifier: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  signal.throwIfAborted();
  const response = await transport(`${endpoint}/auth/keys`, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Provider error bodies may contain submitted credentials. Never echo them.
    throw Error(
      `OpenRouter authorization exchange returned HTTP ${response.status}`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("OpenRouter authorization returned no body");
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 32768) throw Error("Invalid authorization response size");
      chunks.push(value);
    }
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (
      !data ||
      typeof data !== "object" ||
      !("key" in data) ||
      typeof data.key !== "string"
    )
      throw Error("OpenRouter authorization did not return an API key");
    return validateBearer(data.key);
  } finally {
    await reader.cancel();
  }
}

interface Attempt {
  value: ProviderLoginStatus;
  verifier: string;
  abort: AbortController;
  server?: Server;
  timer?: NodeJS.Timeout;
  pending?: Promise<ProviderLoginStatus>;
}

/** Privileged process only. Verifier/key/code never enter snapshots or URLs.
 * The provider issues a user-controlled API KEY, not a refresh-token grant.
 * Saving is injected so it can use Synora's endpoint-scoped credential store.
 */
export class OpenRouterLogin {
  private attempt?: Attempt;
  private starting = false;
  private disposed = false;
  constructor(
    private readonly options: {
      save: (
        providerId: string,
        endpoint: string,
        key: string,
      ) => Promise<void>;
      // Dependency injection for offline protocol qualification, not UI/config.
      exchange?: Exchange;
      ttlMs?: number;
    },
  ) {}

  snapshot(): ProviderLoginStatus | null {
    return this.attempt ? structuredClone(this.attempt.value) : null;
  }
  get busy() {
    return (
      this.starting ||
      ["awaiting_authorization", "exchanging"].includes(
        this.attempt?.value.status ?? "",
      )
    );
  }
  private current(id: string) {
    const a = this.attempt;
    if (!a || a.value.id !== id)
      throw Error("Unknown or superseded provider login");
    return a;
  }
  private close(a: Attempt) {
    clearTimeout(a.timer);
    a.verifier = "";
    delete a.value.authorizationUrl;
    if (a.server) {
      a.server.close();
      a.server.closeIdleConnections();
    }
  }
  async start(providerId: string, method: ProviderLoginStatus["method"]) {
    if (this.disposed) throw Error("Provider login controller is closed");
    if (this.busy)
      throw Error("Finish or cancel the active provider login first");
    if (!/^[a-z0-9-]{1,80}$/.test(providerId))
      throw Error("Invalid provider identity");
    if (method !== "browser" && method !== "paste-code")
      throw Error("Unsupported login method");
    this.starting = true;
    const ttl = this.options.ttlMs ?? 600000;
    const a: Attempt = {
      verifier: randomBytes(32).toString("base64url"),
      abort: new AbortController(),
      value: {
        id: randomUUID(),
        providerId,
        endpoint,
        method,
        status: "awaiting_authorization",
        expiresAt: Date.now() + ttl,
      },
    };
    this.attempt = a;
    try {
      const url = new URL("https://openrouter.ai/auth");
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(a.verifier).digest("base64url"),
      );
      url.searchParams.set("code_challenge_method", "S256");
      if (method === "paste-code")
        url.searchParams.set("key_label", "Synora Harness Desktop");
      else {
        const path = `/callback/${randomBytes(24).toString("hex")}`;
        let authority = "";
        const server = createServer(async (req, res) => {
          const reply = (status: number, message: string) => {
            if (res.destroyed) return;
            res.writeHead(status, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy":
                "default-src 'none'; frame-ancestors 'none'",
              "x-content-type-options": "nosniff",
            });
            res.end(message);
          };
          // Random per-login path binds the callback, independently of PKCE.
          if (
            req.method !== "GET" ||
            req.headers.host !== authority ||
            req.headers.origin ||
            !req.url ||
            req.url.length > 16384
          )
            return reply(400, "Invalid callback");
          let callback: URL;
          try {
            callback = new URL(req.url, `http://${authority}`);
          } catch {
            return reply(400, "Invalid callback URL");
          }
          if (
            callback.pathname !== path ||
            callback.origin !== `http://${authority}`
          )
            return reply(404, "Unknown callback");
          if (this.attempt !== a || a.value.status !== "awaiting_authorization")
            return reply(409, "Authorization is no longer pending");
          if (callback.searchParams.has("error")) {
            a.value.status = "failed";
            a.value.error = "Browser authorization was declined or failed";
            reply(400, a.value.error);
            this.close(a);
            return;
          }
          if (callback.searchParams.getAll("code").length !== 1)
            return reply(400, "Expected one authorization code");
          try {
            const result = await this.submit(
              a.value.id,
              callback.searchParams.get("code")!,
            );
            reply(
              result.status === "authorized" ? 200 : 400,
              result.status === "authorized"
                ? "OpenRouter connected. Return to Synora."
                : "Authorization failed. Return to Synora.",
            );
          } catch {
            reply(400, "Authorization failed. Return to Synora.");
          }
        });
        a.server = server;
        server.headersTimeout = 10000;
        server.requestTimeout = 20000;
        server.setTimeout(10000, (socket) => socket.destroy());
        server.on("upgrade", (_req, socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
        url.searchParams.set("callback_url", `http://${authority}${path}`);
      }
      if (this.disposed || a.value.status !== "awaiting_authorization")
        throw Error("Provider login was cancelled during startup");
      a.value.authorizationUrl = url.href;
      a.timer = setTimeout(() => {
        if (a.value.status === "awaiting_authorization") {
          a.value.status = "expired";
          a.abort.abort();
          this.close(a);
        }
      }, ttl);
      a.timer.unref();
      return structuredClone(a.value);
    } catch {
      if (a.value.status === "awaiting_authorization") {
        a.value.status = "failed";
        a.value.error = "Cannot start provider browser login";
      }
      this.close(a);
      throw Error(a.value.error ?? "Provider login was cancelled");
    } finally {
      this.starting = false;
    }
  }
  async submit(id: string, code: string): Promise<ProviderLoginStatus> {
    const a = this.current(id);
    if (a.value.status !== "awaiting_authorization")
      throw Error("Authorization is not awaiting a code");
    if (Date.now() >= a.value.expiresAt) {
      a.value.status = "expired";
      this.close(a);
      return structuredClone(a.value);
    }
    if (typeof code !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(code))
      throw Error("Invalid authorization code");
    a.value.status = "exchanging";
    delete a.value.authorizationUrl;
    clearTimeout(a.timer);
    a.pending = (async () => {
      try {
        const signal = AbortSignal.any([
          a.abort.signal,
          AbortSignal.timeout(
            Math.max(1, Math.min(15000, a.value.expiresAt - Date.now())),
          ),
        ]);
        const key = validateBearer(
          await (this.options.exchange ?? exchangeOpenRouterKey)(
            code,
            a.verifier,
            signal,
          ),
        );
        signal.throwIfAborted();
        // Cancellation waits for this atomic commit if it has already begun;
        // it must not claim "cancelled" after a credential was saved.
        await this.options.save(a.value.providerId, endpoint, key);
        a.value.status = "authorized";
      } catch {
        if (a.abort.signal.aborted) a.value.status = "cancelled";
        else if (Date.now() >= a.value.expiresAt) a.value.status = "expired";
        else {
          a.value.status = "failed";
          a.value.error =
            "OpenRouter login failed. The code may be expired, rejected, or the credential store unavailable. Start a new login.";
        }
      } finally {
        this.close(a);
      }
      return structuredClone(a.value);
    })();
    return a.pending;
  }
  async cancel(id: string) {
    const a = this.current(id);
    if (a.value.status === "exchanging") {
      a.abort.abort();
      return a.pending!;
    }
    if (a.value.status === "awaiting_authorization") {
      a.abort.abort();
      a.value.status = "cancelled";
      this.close(a);
    }
    return structuredClone(a.value);
  }
  async dispose() {
    this.disposed = true;
    const a = this.attempt;
    if (a) {
      await this.cancel(a.value.id);
      a.server?.closeAllConnections();
    }
  }
}
