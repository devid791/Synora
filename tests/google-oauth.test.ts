import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  GOOGLE_ENDPOINT,
  GOOGLE_SCOPE,
  GoogleLogin,
  GoogleOAuthTransport,
} from "../src/engine/google-oauth";
import { GoogleAccounts } from "../src/main/google-accounts";
import { geminiModels, geminiBridge } from "../src/engine/gemini-provider";
import { NativeHistory } from "../src/engine/native-history";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import {
  geminiFixtureModel,
  geminiCapabilities,
  geminiFrames,
  geminiSse,
} from "./fixtures/gemini-wire";
const client = {
  clientId: "synora-fixture.apps.googleusercontent.com",
  clientSecret: "SYNORA_CLIENT_SECRET",
  quotaProject: "synora-fixture",
};
const provider = {
  id: "google-one",
  kind: "provider" as const,
  providerType: "gemini" as const,
  name: "Google",
  endpoint: GOOGLE_ENDPOINT,
  auth: "oauth" as const,
  tools: [],
  enabled: true,
};
const signal = () => AbortSignal.timeout(3000);
const token = (overrides = {}) => ({
  access_token: "SYNORA_ACCESS",
  refresh_token: "SYNORA_REFRESH",
  expires_in: 3600,
  token_type: "Bearer",
  scope: GOOGLE_SCOPE,
  ...overrides,
});
const grant = (overrides = {}) => ({
  accessToken: "SYNORA_OLD_ACCESS",
  refreshToken: "SYNORA_REFRESH",
  expiresAt: Date.now() + 3600000,
  scopes: [GOOGLE_SCOPE],
  ...overrides,
});
const callback = (s: { authorizationUrl?: string }, code = "fixture-code") => {
  const auth = new URL(s.authorizationUrl!),
    u = new URL(auth.searchParams.get("redirect_uri")!);
  u.search = new URLSearchParams({
    state: auth.searchParams.get("state")!,
    code,
  }).toString();
  return u;
};
const request = async (u: URL | string, opts: RequestInit = {}) => {
  const r = await fetch(u, { ...opts, signal: signal() });
  await r.text();
  return r;
};
test("Google exchange deadline expires rather than reporting operator cancellation", async (t) => {
  let saves = 0;
  const login = new GoogleLogin({
    ttlMs: 500,
    save: async () => {
      saves++;
    },
    transport: new GoogleOAuthTransport(async (_u, options) => {
      await delay(5000, undefined, { signal: options!.signal! });
      return Response.json(token());
    }),
  });
  t.after(() => login.dispose());
  const pending = await login.start(provider.id, client);
  const r = await request(callback(pending));
  assert.equal(r.status, 400);
  assert.equal(login.snapshot()?.status, "expired");
  assert.equal(saves, 0);
  assert.equal(login.busy, false);
});

test("Google fixed token endpoints: exact PKCE/refresh/revoke fields, partial grants, bounded errors, no secrets in errors", async () => {
  const seen: { url: string; body: URLSearchParams }[] = [];
  let response = token(),
    status = 200;
  const transport = new GoogleOAuthTransport(async (url, options) => {
    assert.equal(options?.redirect, "error");
    assert.equal(options?.method, "POST");
    assert.equal(
      new Headers(options?.headers).get("content-type"),
      "application/x-www-form-urlencoded",
    );
    seen.push({
      url: String(url),
      body: new URLSearchParams(String(options?.body)),
    });
    return Response.json(response, { status });
  });
  const g = await transport.exchange(
    client,
    "code",
    "verifier",
    "http://127.0.0.1:1234",
    signal(),
  );
  assert.equal(g.accessToken, "SYNORA_ACCESS");
  assert.deepEqual(Object.fromEntries(seen[0].body), {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code: "code",
    code_verifier: "verifier",
    redirect_uri: "http://127.0.0.1:1234",
    grant_type: "authorization_code",
  });
  response = token({
    access_token: "NEW",
    refresh_token: undefined,
    scope: undefined,
  });
  const next = await transport.refresh(client, g, signal());
  assert.equal(next.refreshToken, g.refreshToken);
  assert.equal(next.accessToken, "NEW");
  assert.deepEqual(Object.fromEntries(seen[1].body), {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: g.refreshToken,
    grant_type: "refresh_token",
  });
  await transport.revoke(next, signal());
  assert.equal(seen[2].url, "https://oauth2.googleapis.com/revoke");
  assert.deepEqual(Object.fromEntries(seen[2].body), { token: g.refreshToken });
  for (const invalid of [
    { scope: "openid" },
    { refresh_token: undefined },
    { token_type: "DPoP" },
    { access_token: "bad\nsecret" },
    { expires_in: -1 },
    { expires_in: 1e12 },
  ]) {
    response = token(invalid);
    await assert.rejects(
      transport.exchange(
        client,
        "code",
        "verifier",
        "http://127.0.0.1:1234",
        signal(),
      ),
      /Invalid Google|did not grant/,
    );
  }
  status = 400;
  response = {
    error: "invalid_grant",
    error_description: "SYNORA_REFRESH",
  } as any;
  await assert.rejects(
    transport.refresh(client, g, signal()),
    (e: any) => e.needsLogin && !e.message.includes("SYNORA_REFRESH"),
  );
  status = 302;
  await assert.rejects(
    transport.refresh(client, g, signal()),
    /expired|HTTP 302/,
  );
  const oversized = new GoogleOAuthTransport(
    async () => new Response("S".repeat(65537)),
  );
  await assert.rejects(oversized.refresh(client, g, signal()), /invalid data/);
});

test("Google loopback PKCE validates state/host/origin/method, saves once, redacts all secrets and closes callback", async (t) => {
  let count = 0,
    challenge = "",
    redirect = "";
  const transport = new GoogleOAuthTransport(async (url, options) => {
    count++;
    const f = new URLSearchParams(String(options!.body));
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    assert.equal(f.get("code"), "fixture-code");
    assert.equal(f.get("redirect_uri"), redirect);
    assert.equal(
      createHash("sha256").update(f.get("code_verifier")!).digest("base64url"),
      challenge,
    );
    return Response.json(token());
  });
  let saved = 0;
  const login = new GoogleLogin({
    transport,
    save: async (id, c, g) => {
      assert.equal(id, provider.id);
      assert.deepEqual(c, client);
      assert.equal(g.refreshToken, "SYNORA_REFRESH");
      saved++;
    },
  });
  t.after(() => login.dispose());
  const a = await login.start(provider.id, client),
    url = new URL(a.authorizationUrl!);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.pathname, "/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), GOOGLE_SCOPE);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.has("client_secret"), false);
  challenge = url.searchParams.get("code_challenge")!;
  redirect = url.searchParams.get("redirect_uri")!;
  const good = callback(a),
    wrong = new URL(good);
  wrong.searchParams.set("state", "wrong");
  assert.equal((await request(wrong)).status, 400);
  assert.equal((await request(good, { method: "POST" })).status, 400);
  // fetch normalizes Host on this Node runtime; send the actual invalid wire header.
  const badHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      good,
      { headers: { host: "host.invalid" } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 400);
  const malformed = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(good, { path: "//[" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(malformed, 400);
  assert.equal(
    (
      await request(good, {
        headers: { origin: "https://accounts.google.com" },
      })
    ).status,
    400,
  );
  assert.equal((await request(`${good}&code=second`)).status, 400);
  assert.equal((await request(`${good}&state=second`)).status, 400);
  assert.equal(count, 0);
  const ok = await request(good);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(saved, 1);
  assert.equal(count, 1);
  assert.equal(login.snapshot()?.status, "authorized");
  assert.equal(login.busy, false);
  for (const secret of [
    client.clientSecret,
    "SYNORA_ACCESS",
    "SYNORA_REFRESH",
    "fixture-code",
    challenge,
  ])
    assert.equal(JSON.stringify(login.snapshot()).includes(secret), false);
  await assert.rejects(request(good));
});

test("Google denied, cancelled, expired and superseded attempts cannot commit; in-flight cancellation closes exchange", async (t) => {
  let saves = 0;
  const login = new GoogleLogin({
    transport: new GoogleOAuthTransport(async (_u, options) => {
      await delay(10000, undefined, { signal: options!.signal! });
      return Response.json(token());
    }),
    save: async () => {
      saves++;
    },
    ttlMs: 2000,
  });
  t.after(() => login.dispose());
  const first = await login.start(provider.id, client),
    denied = callback(first);
  denied.searchParams.delete("code");
  denied.searchParams.set("error", "access_denied");
  assert.equal((await request(denied)).status, 400);
  assert.equal(login.snapshot()?.status, "failed");
  const second = await login.start(provider.id, client);
  await assert.rejects(login.cancel(first.id), /Unknown/);
  const pending = request(callback(second)).catch(() => undefined);
  for (let i = 0; i < 50 && login.snapshot()?.status !== "exchanging"; i++)
    await delay(5);
  assert.equal(login.snapshot()?.status, "exchanging");
  assert.equal((await login.cancel(second.id)).status, "cancelled");
  await pending;
  assert.equal(saves, 0);
  const expiry = new GoogleLogin({
    transport: new GoogleOAuthTransport(),
    save: async () => {
      saves++;
    },
    ttlMs: 25,
  });
  t.after(() => expiry.dispose());
  const a = await expiry.start(provider.id, client);
  await delay(50);
  assert.equal(expiry.snapshot()?.status, "expired");
  await assert.rejects(request(callback(a)));
  await login.dispose();
  await assert.rejects(login.start(provider.id, client), /closed/);
});

test("Google protected grant lifecycle: cold restart, queued single refresh, expiry, failed revoke preservation, no key-store crossover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-google-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now(),
    refreshes = 0,
    rejected = false,
    rejectRevoke = false;
  const transport = new GoogleOAuthTransport(
    async (u, opts) => {
      if (String(u).endsWith("revoke"))
        return Response.json({}, { status: rejectRevoke ? 500 : 200 });
      refreshes++;
      await delay(20, undefined, { signal: opts!.signal! });
      return rejected
        ? Response.json(
            { error: "invalid_grant", error_description: "SYNORA_REFRESH" },
            { status: 400 },
          )
        : Response.json(
            token({
              access_token: `NEW_ACCESS_${refreshes}`,
              refresh_token: undefined,
            }),
          );
    },
    () => now,
  );
  const accounts = new GoogleAccounts(
    directory,
    undefined,
    transport,
    () => now,
  );
  assert.equal((await accounts.status(provider)).configured, false);
  await accounts.configure(provider, client);
  await accounts.saveGrant(provider, client, grant({ expiresAt: now - 1 }));
  const results = await Promise.all(
    Array.from({ length: 8 }, () => accounts.access(provider)),
  );
  assert.equal(refreshes, 1);
  assert.ok(results.every((r) => r.accessToken === "NEW_ACCESS_1"));
  assert.equal(results[0].quotaProject, client.quotaProject);
  const state = await accounts.status(provider);
  assert.equal(state.authorized, true);
  for (const secret of ["SYNORA_REFRESH", client.clientSecret, "NEW_ACCESS_1"])
    assert.equal(JSON.stringify(state).includes(secret), false);
  const cold = new GoogleAccounts(directory, undefined, transport, () => now);
  assert.equal((await cold.access(provider)).accessToken, "NEW_ACCESS_1");
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, `${provider.id}.json`))).mode & 0o777,
      0o600,
    );
  await assert.rejects(
    cold.access({ ...provider, endpoint: "https://other.invalid" }),
    /official/,
  );
  await assert.rejects(
    cold.access({ ...provider, auth: "api-key" }),
    /browser/,
  );
  await assert.rejects(
    cold.configure(provider, { ...client, quotaProject: "other-project" }),
    /Disconnect/,
  );
  rejectRevoke = true;
  await assert.rejects(cold.disconnect(provider, true), /HTTP 500/);
  assert.equal((await cold.status(provider)).authorized, true);
  now += 3600000;
  rejected = true;
  await assert.rejects(cold.access(provider), /Sign in again/);
  assert.equal((await cold.status(provider)).needsLogin, true);
  await assert.rejects(cold.access(provider), /Sign in with Google/);
  assert.equal(refreshes, 2);
  rejectRevoke = false;
  assert.equal((await cold.disconnect(provider, true)).authorized, false);
  assert.ok(
    !(await readFile(join(directory, `${provider.id}.json`), "utf8")).includes(
      "SYNORA_REFRESH",
    ),
  );
});

test("Google OS-encrypted grant cannot downgrade or leak secrets; cancelled refresh cannot restore a locally disconnected grant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-google-cipher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A deliberately test-only reversible cipher exercises the injected OS boundary, not crypto strength.
  const cipher = {
    seal: (x: string) => Buffer.from(x.split("").reverse().join("")),
    open: (b: Buffer) => b.toString().split("").reverse().join(""),
  };
  const transport = new GoogleOAuthTransport(async (_u, opts) => {
    await delay(3000, undefined, { signal: opts!.signal! });
    return Response.json(token());
  });
  const a = new GoogleAccounts(directory, cipher, transport);
  await a.configure(provider, client);
  await a.saveGrant(provider, client, grant({ expiresAt: 1 }));
  assert.ok(
    !(await readFile(join(directory, `${provider.id}.json`), "utf8")).includes(
      client.clientSecret,
    ),
  );
  const locked = new GoogleAccounts(directory);
  await assert.rejects(
    locked.configure(provider, client),
    /Unlock|unavailable/,
  );
  const abort = new AbortController(),
    pending = a.access(provider, abort.signal);
  const removed = a.disconnect(provider, false);
  abort.abort();
  await assert.rejects(pending);
  assert.equal((await removed).authorized, false);
  await assert.rejects(a.access(provider), /Sign in/);
  // Recovery works without decrypting an unavailable old OS envelope.
  assert.equal((await locked.forget(provider)).configured, false);
  await locked.configure(provider, client);
  assert.equal((await locked.status(provider)).configured, true);
});

test("Gemini OAuth catalog and SSE resolve fresh per-request credentials, keep quota header and redact refreshed credentials on errors", async (t) => {
  const seen: any[] = [];
  let mode: "ok" | "error" = "ok",
    generation = 0;
  const s = createServer(async (req, res) => {
    seen.push({
      token: req.headers.authorization,
      key: req.headers["x-goog-api-key"],
      project: req.headers["x-goog-user-project"],
      url: req.url,
    });
    for await (const _ of req) {
    }
    if (req.method === "GET") {
      res.end(JSON.stringify({ models: [geminiFixtureModel] }));
      return;
    }
    if (mode === "error") {
      res.writeHead(401);
      res.end(`rejected ${req.headers.authorization}`);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      geminiSse(geminiFrames("oauth-stream", [{ text: "OAuth output" }])),
    );
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.close();
    s.closeAllConnections();
  });
  const endpoint = `http://127.0.0.1:${(s.address() as any).port}/v1beta`;
  const oauth = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    return {
      accessToken: `FRESH_ACCESS_${++generation}`,
      quotaProject: client.quotaProject,
    };
  };
  assert.equal(
    (await geminiModels(endpoint, undefined, oauth))[0].id,
    geminiCapabilities.id,
  );
  const bridge = await geminiBridge({
    endpoint,
    token: "OLD_ACCESS",
    oauth,
    model: geminiCapabilities,
    history: new NativeHistory(Buffer.alloc(32, 1), "oauth-test", "gemini"),
  });
  t.after(() => bridge.close());
  const send = () =>
    fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      signal: signal(),
      headers: {
        [PROVIDER_TOKEN_HEADER]: bridge.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: geminiCapabilities.id,
        store: false,
        stream: true,
        input: [{ role: "user", content: "Hello" }],
      }),
    });
  const success = await send(),
    text = await success.text();
  assert.equal(success.status, 200, text);
  assert.match(text, /response.completed/);
  assert.match(text, /OAuth output/);
  mode = "error";
  const failure = await send();
  assert.equal(failure.status, 401);
  const error = await failure.text();
  assert.equal(error.includes("FRESH_ACCESS_3"), false);
  assert.match(error, /REDACTED/);
  assert.deepEqual(
    seen.map((r) => r.token),
    ["Bearer FRESH_ACCESS_1", "Bearer FRESH_ACCESS_2", "Bearer FRESH_ACCESS_3"],
  );
  assert.ok(
    seen.every(
      (r) =>
        r.key === undefined &&
        r.project === client.quotaProject &&
        !r.url.includes("ACCESS"),
    ),
  );
});
