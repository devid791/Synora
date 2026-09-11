import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  OpenRouterLogin,
  exchangeOpenRouterKey,
} from "../src/engine/openrouter-login";
import { ProviderCredentials } from "../src/main/provider-credentials";

const endpoint = "https://openrouter.ai/api/v1";
const provider = {
  id: "router-one",
  name: "OpenRouter auth fixture",
  kind: "provider" as const,
  endpoint,
  auth: "api-key" as const,
  tools: [],
  enabled: true,
};

test("OpenRouter headless PKCE binds S256 to the issued code and saves only host-side endpoint-scoped credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-router-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new ProviderCredentials(directory);
  const token = `fixture-${randomBytes(24).toString("hex")}`;
  let verifier = "",
    challenge = "";
  const login = new OpenRouterLogin({
    exchange: async (code, secret, signal) => {
      signal.throwIfAborted();
      assert.equal(code, "fixture-code");
      assert.match(secret, /^[a-zA-Z0-9_-]{43}$/);
      verifier = secret;
      assert.equal(
        createHash("sha256").update(secret).digest("base64url"),
        challenge,
      );
      return token;
    },
    save: async (id, url, key) => {
      assert.equal(id, provider.id);
      assert.equal(url, endpoint);
      await vault.save(provider, key);
    },
  });
  t.after(() => login.dispose());
  const pending = await login.start(provider.id, "paste-code");
  const url = new URL(pending.authorizationUrl!);
  assert.equal(url.origin, "https://openrouter.ai");
  assert.equal(url.pathname, "/auth");
  assert.equal(url.searchParams.has("callback_url"), false);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  challenge = url.searchParams.get("code_challenge")!;
  await assert.rejects(login.start(provider.id, "browser"), /Finish or cancel/);
  assert.equal(
    (await login.submit(pending.id, "fixture-code")).status,
    "authorized",
  );
  assert.equal(login.busy, false);
  assert.equal((await vault.status(provider)).usable, true);
  assert.equal(await new ProviderCredentials(directory).load(provider), token);
  assert.equal(
    (await vault.status({ ...provider, endpoint: "https://other.invalid/v1" }))
      .present,
    false,
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, `${provider.id}.json`))).mode & 0o777,
      0o600,
    );
  for (const secret of [token, verifier, "fixture-code"])
    assert.equal(JSON.stringify(login.snapshot()).includes(secret), false);
  assert.equal(login.snapshot()?.authorizationUrl, undefined);
  await assert.rejects(
    login.submit(pending.id, "fixture-code"),
    /not awaiting/,
  );
  await vault.remove(provider);
  assert.equal((await vault.status(provider)).present, false);
});

test("OpenRouter real loopback callback rejects wrong path/host/origin/method/duplicates and closes after one exchange", async (t) => {
  let count = 0;
  const login = new OpenRouterLogin({
    exchange: async () => {
      count++;
      return "fixture-token";
    },
    save: async () => {},
  });
  t.after(() => login.dispose());
  const pending = await login.start("router", "browser");
  const callback = new URL(
    new URL(pending.authorizationUrl!).searchParams.get("callback_url")!,
  );
  assert.equal(callback.hostname, "127.0.0.1");
  assert.match(callback.pathname, /^\/callback\/[a-f0-9]{48}$/);
  const send = async (url: string, init: RequestInit = {}) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    const body = await r.text();
    assert.ok(!body.includes("fixture-code"));
    return r;
  };
  assert.equal(
    (await send(`${callback.origin}/other?code=fixture-code`)).status,
    404,
  );
  assert.equal((await send(callback.href, { method: "POST" })).status, 400);
  assert.equal(
    (await send(callback.href, { headers: { host: "untrusted.invalid" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await send(callback.href, {
        headers: { origin: "https://untrusted.invalid" },
      })
    ).status,
    400,
  );
  assert.equal((await send(`${callback}?code=one&code=two`)).status, 400);
  assert.equal(count, 0);
  const response = await send(`${callback}?code=fixture-code`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(login.snapshot()?.status, "authorized");
  assert.equal(count, 1);
  await assert.rejects(send(`${callback}?code=fixture-code`));
});

test("OpenRouter cancellation, expiry and stale attempt IDs never save credentials", async (t) => {
  let saves = 0;
  const login = new OpenRouterLogin({
    ttlMs: 40,
    exchange: async () => "fixture",
    save: async () => {
      saves++;
    },
  });
  t.after(() => login.dispose());
  const first = await login.start("one", "paste-code");
  assert.equal((await login.cancel(first.id)).status, "cancelled");
  const second = await login.start("two", "paste-code");
  await assert.rejects(login.submit(first.id, "fixture"), /superseded/);
  await delay(65);
  assert.equal(login.snapshot()?.status, "expired");
  await assert.rejects(login.submit(second.id, "fixture"), /not awaiting/);
  assert.equal(saves, 0);
  await login.dispose();
  await assert.rejects(login.start("three", "browser"), /closed/);
});

test("OpenRouter pending exchange aborts; cancellation during atomic save reports its actual committed outcome", async (t) => {
  let saves = 0;
  const login = new OpenRouterLogin({
    exchange: async (_code, _verifier, signal) => {
      await delay(10000, undefined, { signal });
      return "fixture";
    },
    save: async () => {
      saves++;
    },
  });
  t.after(() => login.dispose());
  const a = await login.start("router", "paste-code");
  const pending = login.submit(a.id, "fixture");
  await assert.rejects(login.submit(a.id, "fixture"), /not awaiting/);
  assert.equal((await login.cancel(a.id)).status, "cancelled");
  assert.equal((await pending).status, "cancelled");
  assert.equal(saves, 0);

  let release!: () => void, started!: () => void;
  const inSave = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const committing = new OpenRouterLogin({
    exchange: async () => "fixture",
    save: async () => {
      started();
      await gate;
      saves++;
    },
  });
  t.after(() => committing.dispose());
  const b = await committing.start("router", "paste-code");
  const finish = committing.submit(b.id, "fixture");
  await inSave;
  const cancelled = committing.cancel(b.id);
  release();
  assert.equal((await finish).status, "authorized");
  assert.equal((await cancelled).status, "authorized");
  assert.equal(saves, 1);
});

test("OpenRouter errors/denial/malformed code are explicit, redact secrets and retain old credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-router-denial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new ProviderCredentials(directory);
  await vault.save(provider, "old-fixture-key");
  const before = await readFile(join(directory, `${provider.id}.json`));
  let saves = 0;
  const login = new OpenRouterLogin({
    exchange: async () => {
      throw Error("private-code-and-key");
    },
    save: async () => {
      saves++;
    },
  });
  t.after(() => login.dispose());
  const pending = await login.start(provider.id, "paste-code");
  for (const code of ["", "abc\n", " ", "x".repeat(8193)])
    await assert.rejects(login.submit(pending.id, code), /Invalid/);
  const failure = await login.submit(pending.id, "fixture");
  assert.equal(failure.status, "failed");
  assert.ok(!JSON.stringify(failure).includes("private-code-and-key"));
  const denied = await login.start(provider.id, "browser");
  const callback = new URL(denied.authorizationUrl!).searchParams.get(
    "callback_url",
  )!;
  const response = await fetch(
    `${callback}?error=access_denied&error_description=private`,
    { signal: AbortSignal.timeout(3000) },
  );
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes("private"));
  assert.equal(login.snapshot()?.status, "failed");
  assert.equal(saves, 0);
  assert.deepEqual(
    await readFile(join(directory, `${provider.id}.json`)),
    before,
  );
});

test("OpenRouter exchange contacts only the official key endpoint, disables redirects and validates returned key/body", async () => {
  const capture: unknown[] = [];
  const fake = ((url, init) => {
    capture.push({ url, ...init });
    return Promise.resolve(
      new Response('{"key":"fixture-minted-key"}', { status: 200 }),
    );
  }) as typeof fetch;
  const signal = AbortSignal.timeout(3000);
  assert.equal(
    await exchangeOpenRouterKey(
      "fixture-code",
      "fixture-verifier",
      signal,
      fake,
    ),
    "fixture-minted-key",
  );
  const sent = capture[0] as RequestInit & { url: string };
  assert.equal(sent.url, `${endpoint}/auth/keys`);
  assert.equal(sent.redirect, "error");
  assert.equal(sent.method, "POST");
  assert.equal(sent.signal, signal);
  assert.deepEqual(JSON.parse(sent.body as string), {
    code: "fixture-code",
    code_verifier: "fixture-verifier",
    code_challenge_method: "S256",
  });
  assert.equal(new Headers(sent.headers).has("authorization"), false);
  for (const body of [
    "{}",
    '{"key":"Bearer wrong"}',
    '{"key":5}',
    "{",
    "x".repeat(32769),
  ]) {
    await assert.rejects(
      exchangeOpenRouterKey(
        "fixture",
        "verifier",
        signal,
        (async () => new Response(body)) as typeof fetch,
      ),
    );
  }
  for (const status of [302, 400, 403, 500]) {
    await assert.rejects(
      exchangeOpenRouterKey(
        "fixture",
        "verifier",
        signal,
        (async () =>
          new Response("secret-provider-body", { status })) as typeof fetch,
      ),
      (e: unknown) => {
        assert.match(String(e), new RegExp(`HTTP ${status}`));
        assert.ok(!String(e).includes("secret-provider-body"));
        return true;
      },
    );
  }
});
