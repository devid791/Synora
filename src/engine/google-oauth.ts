import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { googleClientSchema, type GoogleClient } from "../shared/google-oauth";
import type { ProviderLoginStatus } from "../shared/provider-login";
import { validateBearer } from "./axiom-auth";

export const GOOGLE_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta";
// Documented Google Cloud API scope; no invented consumer Gemini/CLI grant.
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const tokenSchema = z
  .object({
    accessToken: z.string().min(1).max(16384),
    refreshToken: z.string().min(1).max(16384),
    expiresAt: z.number().finite().positive(),
    refreshExpiresAt: z.number().finite().positive().optional(),
    scopes: z.array(z.string()).min(1),
  })
  .strict();
export const googleGrantSchema = tokenSchema.superRefine((g, ctx) => {
  try {
    validateBearer(g.accessToken);
    validateBearer(g.refreshToken);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid Google credential" });
  }
  if (!g.scopes.includes(GOOGLE_SCOPE))
    ctx.addIssue({
      code: "custom",
      message: "Required Gemini permission was not granted",
    });
});
export type GoogleGrant = z.infer<typeof googleGrantSchema>;
export class GoogleOAuthError extends Error {
  constructor(
    readonly needsLogin: boolean,
    message: string,
  ) {
    super(message);
  }
}
/** Fixed official endpoints; injection is host-only and exercised by tests. */
export class GoogleOAuthTransport {
  constructor(
    private transport: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async post(
    path: "token" | "revoke",
    fields: Record<string, string>,
    signal: AbortSignal,
  ) {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    try {
      const response = await this.transport(
        `https://oauth2.googleapis.com/${path}`,
        {
          method: "POST",
          redirect: "error",
          signal: bounded,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams(fields),
        },
      );
      const reader = response.body?.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        if (reader)
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 65536) throw Error();
            chunks.push(value);
          }
      } finally {
        await reader?.cancel();
      }
      bounded.throwIfAborted();
      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        if (!(path === "revoke" && response.status === 200 && !bytes))
          throw Error();
      }
      if (!response.ok) {
        const expired =
          path === "token" &&
          !!body &&
          typeof body === "object" &&
          "error" in body &&
          body.error === "invalid_grant";
        throw new GoogleOAuthError(
          expired,
          expired
            ? "Google authorization expired or was revoked. Sign in again."
            : `Google ${path} returned HTTP ${response.status}`,
        );
      }
      return body;
    } catch (e) {
      if (e instanceof GoogleOAuthError) throw e;
      throw new GoogleOAuthError(
        false,
        `Google ${path} failed, timed out or returned invalid data`,
      );
    }
  }
  private grant(raw: unknown, previous?: GoogleGrant): GoogleGrant {
    const r = z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number().int().positive().max(31536000),
        refresh_token_expires_in: z
          .number()
          .int()
          .positive()
          .max(315360000)
          .optional(),
        token_type: z.literal("Bearer"),
        scope: z.string().optional(),
      })
      .safeParse(raw);
    if (!r.success)
      throw new GoogleOAuthError(false, "Invalid Google token response");
    const v = r.data,
      now = this.now();
    // OAuth permits an omitted scope only when unchanged from the requested grant.
    const parsed = googleGrantSchema.safeParse({
      accessToken: v.access_token,
      refreshToken: v.refresh_token ?? previous?.refreshToken,
      expiresAt: now + v.expires_in * 1000,
      ...(v.refresh_token_expires_in
        ? { refreshExpiresAt: now + v.refresh_token_expires_in * 1000 }
        : previous?.refreshExpiresAt
          ? { refreshExpiresAt: previous.refreshExpiresAt }
          : {}),
      scopes: v.scope
        ? v.scope.split(/\s+/)
        : (previous?.scopes ?? [GOOGLE_SCOPE]),
    });
    if (!parsed.success)
      throw new GoogleOAuthError(
        false,
        "Google did not grant Gemini access with a renewable credential",
      );
    return parsed.data;
  }
  async exchange(
    client: GoogleClient,
    code: string,
    verifier: string,
    redirect: string,
    signal: AbortSignal,
  ) {
    return this.grant(
      await this.post(
        "token",
        {
          client_id: client.clientId,
          ...(client.clientSecret
            ? { client_secret: client.clientSecret }
            : {}),
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        },
        signal,
      ),
    );
  }
  async refresh(client: GoogleClient, grant: GoogleGrant, signal: AbortSignal) {
    return this.grant(
      await this.post(
        "token",
        {
          client_id: client.clientId,
          ...(client.clientSecret
            ? { client_secret: client.clientSecret }
            : {}),
          refresh_token: grant.refreshToken,
          grant_type: "refresh_token",
        },
        signal,
      ),
      grant,
    );
  }
  async revoke(grant: GoogleGrant, signal: AbortSignal) {
    await this.post("revoke", { token: grant.refreshToken }, signal);
  }
}
type Attempt = {
  value: ProviderLoginStatus;
  verifier: string;
  state: string;
  client: GoogleClient;
  abort: AbortController;
  server: Server;
  redirect: string;
  timer?: NodeJS.Timeout;
  pending?: Promise<void>;
};
export class GoogleLogin {
  private attempt?: Attempt;
  private starting = false;
  private disposed = false;
  constructor(
    private options: {
      transport: GoogleOAuthTransport;
      save(id: string, client: GoogleClient, grant: GoogleGrant): Promise<void>;
      ttlMs?: number;
    },
  ) {}
  get busy() {
    return (
      this.starting ||
      ["awaiting_authorization", "exchanging"].includes(
        this.attempt?.value.status ?? "",
      )
    );
  }
  snapshot() {
    return this.attempt ? structuredClone(this.attempt.value) : null;
  }
  private close(a: Attempt) {
    clearTimeout(a.timer);
    a.verifier = "";
    a.state = "";
    delete a.value.authorizationUrl;
    a.server.close();
    a.server.closeIdleConnections();
  }
  async start(id: string, raw: GoogleClient) {
    if (this.disposed) throw Error("Google login controller is closed");
    if (this.busy)
      throw Error("Finish or cancel the active Google login first");
    if (!/^[a-z0-9-]{1,80}$/.test(id)) throw Error("Invalid provider identity");
    const client = googleClientSchema.parse(raw);
    this.starting = true;
    const a: Attempt = {
      value: {
        id: randomUUID(),
        providerId: id,
        endpoint: GOOGLE_ENDPOINT,
        method: "browser",
        status: "awaiting_authorization",
        expiresAt: Date.now() + (this.options.ttlMs ?? 600000),
      },
      verifier: randomBytes(32).toString("base64url"),
      state: randomBytes(32).toString("base64url"),
      client,
      abort: new AbortController(),
      server: createServer(),
      redirect: "",
    };
    this.attempt = a;
    a.server.on("request", async (req, res) => {
      const reply = (code: number, text: string) => {
        if (res.destroyed) return;
        res.writeHead(code, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          connection: "close",
        });
        res.end(text);
      };
      if (
        !a.redirect ||
        req.method !== "GET" ||
        req.headers.host !== new URL(a.redirect).host ||
        req.headers.origin ||
        !req.url ||
        !req.url.startsWith("/") ||
        req.url.length > 16384
      )
        return reply(400, "Invalid callback");
      let url: URL;
      try {
        url = new URL(req.url, a.redirect);
      } catch {
        return reply(400, "Invalid callback URL");
      }
      const states = url.searchParams.getAll("state");
      if (url.origin !== a.redirect || url.pathname !== "/")
        return reply(404, "Unknown callback");
      if (a !== this.attempt || a.value.status !== "awaiting_authorization")
        return reply(409, "Authorization is no longer pending");
      if (
        states.length !== 1 ||
        Buffer.byteLength(states[0]) !== Buffer.byteLength(a.state) ||
        !timingSafeEqual(Buffer.from(states[0]), Buffer.from(a.state))
      )
        return reply(400, "Invalid authorization state");
      if (url.searchParams.has("error")) {
        a.value.status = "failed";
        a.value.error = "Google authorization was declined or failed";
        reply(400, a.value.error);
        this.close(a);
        return;
      }
      const codes = url.searchParams.getAll("code");
      if (codes.length !== 1 || !/^[\x21-\x7e]{1,8192}$/.test(codes[0]))
        return reply(400, "Expected one authorization code");
      if (Date.now() >= a.value.expiresAt) {
        a.value.status = "expired";
        reply(400, "Authorization expired");
        this.close(a);
        return;
      }
      a.value.status = "exchanging";
      delete a.value.authorizationUrl;
      a.pending = (async () => {
        try {
          const signal = AbortSignal.any([
            a.abort.signal,
            AbortSignal.timeout(Math.max(1, a.value.expiresAt - Date.now())),
          ]);
          const grant = await this.options.transport.exchange(
            a.client,
            codes[0],
            a.verifier,
            a.redirect,
            signal,
          );
          signal.throwIfAborted();
          await this.options.save(id, a.client, grant);
          a.value.status = "authorized";
        } catch {
          a.value.status =
            Date.now() >= a.value.expiresAt
              ? "expired"
              : a.abort.signal.aborted
                ? "cancelled"
                : "failed";
          if (a.value.status === "failed")
            a.value.error =
              "Google login failed. Verify the Desktop client, granted Gemini permission and credential storage, then retry.";
        } finally {
          reply(
            a.value.status === "authorized" ? 200 : 400,
            a.value.status === "authorized"
              ? "Google connected. Return to Synora."
              : "Authorization failed. Return to Synora.",
          );
          this.close(a);
        }
      })();
      await a.pending;
    });
    try {
      a.server.headersTimeout = 10000;
      a.server.requestTimeout = 20000;
      a.server.setTimeout(20000, (s) => s.destroy());
      a.server.on("upgrade", (_r, s) => s.destroy());
      await new Promise<void>((resolve, reject) => {
        a.server.once("error", reject);
        a.server.listen(0, "127.0.0.1", resolve);
      });
      a.redirect = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
      if (this.disposed || a.value.status !== "awaiting_authorization")
        throw Error();
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: a.redirect,
        response_type: "code",
        scope: GOOGLE_SCOPE,
        code_challenge: createHash("sha256")
          .update(a.verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        state: a.state,
        access_type: "offline",
        prompt: "consent",
      }).toString();
      a.value.authorizationUrl = url.href;
      a.timer = setTimeout(
        () => {
          a.abort.abort();
          if (a.value.status === "awaiting_authorization") {
            a.value.status = "expired";
            this.close(a);
          }
        },
        Math.max(1, a.value.expiresAt - Date.now()),
      );
      a.timer.unref();
      return structuredClone(a.value);
    } catch {
      if (a.value.status === "awaiting_authorization")
        a.value.status = "failed";
      this.close(a);
      throw Error("Cannot start Google browser authorization");
    } finally {
      this.starting = false;
    }
  }
  async cancel(id: string) {
    const a = this.attempt;
    if (!a || a.value.id !== id) throw Error("Unknown Google login identity");
    if (a.value.status === "exchanging") {
      a.abort.abort();
      await a.pending;
    } else if (a.value.status === "awaiting_authorization") {
      a.abort.abort();
      a.value.status = "cancelled";
      this.close(a);
    }
    return structuredClone(a.value);
  }
  async dispose() {
    this.disposed = true;
    if (this.attempt) {
      await this.cancel(this.attempt.value.id);
      this.attempt.server.closeAllConnections();
    }
  }
}
