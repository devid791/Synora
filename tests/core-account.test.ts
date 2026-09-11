import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { CoreAccountController } from "../src/engine/core-account";
import type { TransportOptions } from "../src/engine/app-server-transport";
import {
  accountLoginSchema,
  openAiAuthorizationUrl,
  type AccountLogin,
} from "../src/shared/core-account";
import { validateOperation } from "../src/shared/operations";

function fixture(scenario = "normal") {
  let options!: TransportOptions,
    closes = 0,
    account: unknown = null;
  const calls: { method: string; params?: unknown }[] = [];
  const complete = (
    id: string | null = "original-login-id",
    success = true,
  ) => {
    options.onNotification({
      method: "account/login/completed",
      params: {
        loginId: id,
        success,
        error: success ? null : "secret-denial-text",
        onboardingEntrypoint: null,
      },
    });
    if (success) {
      account =
        id === null
          ? { type: "apiKey" }
          : {
              type: "chatgpt",
              email: "fixture@example.invalid",
              planType: "pro",
            };
      options.onNotification({
        method: "account/updated",
        params: {
          authMode: id === null ? "apikey" : "chatgpt",
          planType: id === null ? null : "pro",
        },
      });
    }
  };
  return {
    transport(o: TransportOptions) {
      options = o;
      return {
        async request<T>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params: structuredClone(params) });
          if (method === "initialize") return {} as T;
          if (method === "account/read")
            return { account, requiresOpenaiAuth: true } as T;
          if (method === "account/logout") {
            account = null;
            return {} as T;
          }
          if (method === "account/login/cancel")
            return { status: "canceled" } as T;
          assert.equal(method, "account/login/start");
          if (scenario === "rpc-error")
            throw new Error("access_token=SECRET_FIXTURE");
          if (scenario === "malformed") return { type: "invented" } as T;
          const login = params as AccountLogin;
          if (scenario === "early")
            complete(login.type === "apiKey" ? null : "original-login-id");
          if (scenario === "missing-field")
            o.onNotification({
              method: "account/login/completed",
              params: {
                loginId: "original-login-id",
                error: null,
                onboardingEntrypoint: null,
              },
            });
          if (login.type === "apiKey") return { type: "apiKey" } as T;
          const url =
            scenario === "unsafe"
              ? "https://auth.openai.com.attacker.invalid/login"
              : "https://auth.openai.com/oauth/authorize?state=fixture";
          return (
            login.type === "chatgpt"
              ? { type: "chatgpt", loginId: "original-login-id", authUrl: url }
              : {
                  type: "chatgptDeviceCode",
                  loginId: "original-login-id",
                  verificationUrl: url,
                  userCode: "ABCD-1234",
                }
          ) as T;
        },
        notify(method: string) {
          calls.push({ method });
        },
        respond() {
          throw new Error("No inference tools in account test");
        },
        async close() {
          closes++;
          o.onClose(new Error("closed") as never);
        },
      };
    },
    complete,
    calls,
    options: () => options,
    closes: () => closes,
  };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Account operation did not reach expected state");
}
test("Account operations accept only original managed modes and vetted OpenAI browser origins", () => {
  for (const login of [
    { type: "apiKey", apiKey: "fixture" },
    { type: "chatgpt" },
    { type: "chatgptDeviceCode" },
  ])
    assert.ok(accountLoginSchema.safeParse(login).success);
  for (const login of [
    { type: "chatgptAuthTokens", accessToken: "bad" },
    { type: "chatgpt", issuer: "https://attacker.invalid" },
  ])
    assert.throws(() => validateOperation("coreAccountLogin", [login]));
  for (const url of [
    "http://auth.openai.com",
    "https://auth.openai.com:8443",
    "https://a:b@auth.openai.com",
    "https://auth.openai.com.attacker.invalid",
    "file:///tmp/auth",
    "javascript:alert(1)",
  ])
    assert.throws(() => openAiAuthorizationUrl(url));
  assert.equal(
    openAiAuthorizationUrl(
      "https://auth.openai.com/oauth/authorize?state=original",
    ),
    "https://auth.openai.com/oauth/authorize?state=original",
  );
});
test("Original account identity, early terminal event, private namespace, secret exclusion and cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-account-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const mode of ["apiKey", "chatgpt", "chatgptDeviceCode"] as const) {
    const f = fixture("early"),
      c = new CoreAccountController({
        stateDirectory: directory,
        executable: process.execPath,
        transport: f.transport,
      });
    t.after(() => c.dispose());
    const initial = c.login(
      mode === "apiKey"
        ? { type: mode, apiKey: "sk-DISPOSABLE_FIXTURE" }
        : { type: mode },
    );
    assert.equal(initial.attempt?.status, "starting");
    await assert.rejects(c.read(), /pending account/);
    await until(() => !c.busy);
    const result = c.snapshot();
    assert.equal(result.attempt?.status, "authorized");
    assert.equal(
      result.attempt?.loginId,
      mode === "apiKey" ? null : "original-login-id",
    );
    assert.equal(result.attempt?.id, initial.attempt?.id);
    assert.equal(
      result.account?.account?.type,
      mode === "apiKey" ? "apiKey" : "chatgpt",
    );
    assert.equal(result.attempt?.authorizationUrl, undefined);
    assert.equal(result.attempt?.userCode, undefined);
    assert.ok(!JSON.stringify(result).includes("DISPOSABLE_FIXTURE"));
    assert.equal(f.closes(), 1);
    assert.equal(f.options().env.CODEX_HOME, directory);
    assert.equal(f.options().env.OPENAI_API_KEY, undefined);
    assert.ok(f.options().args.includes('cli_auth_credentials_store="file"'));
    assert.ok(!JSON.stringify(f.options().args).includes("DISPOSABLE_FIXTURE"));
    assert.deepEqual(
      f.calls.map((v) => v.method),
      ["initialize", "initialized", "account/login/start", "account/read"],
    );
    const read = await c.read();
    assert.equal(read.account?.account?.type, result.account?.account?.type);
    const logout = await c.logout();
    assert.equal(logout.account?.account, null);
    assert.equal(logout.attempt, null);
    assert.equal(f.closes(), 3);
  }
});
test("Browser/device pending states survive snapshots; cancel preserves exact Core loginId", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-account-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const type of ["chatgpt", "chatgptDeviceCode"] as const) {
    const f = fixture(),
      c = new CoreAccountController({
        stateDirectory: directory,
        executable: process.execPath,
        transport: f.transport,
      });
    t.after(() => c.dispose());
    const first = c.login({ type });
    await until(
      () => c.snapshot().attempt?.status.startsWith("awaiting_") ?? false,
    );
    assert.ok(c.url(first.attempt!.id).startsWith("https://auth.openai.com/"));
    assert.equal(
      c.snapshot().attempt?.userCode,
      type === "chatgptDeviceCode" ? "ABCD-1234" : undefined,
    );
    await assert.rejects(c.cancel("stale"), /Stale/);
    const result = await c.cancel(first.attempt!.id);
    assert.equal(result.attempt?.status, "cancelled");
    assert.equal(c.busy, false);
    assert.equal(f.closes(), 1);
    assert.deepEqual(
      f.calls.find((v) => v.method === "account/login/cancel")?.params,
      { loginId: "original-login-id" },
    );
    assert.throws(() => c.url(first.attempt!.id));
  }
});
test("Denied, malformed, unsafe, mismatched and timeout account flows never become authorized", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-account-negative-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const scenario of [
    "malformed",
    "missing-field",
    "unsafe",
    "rpc-error",
    "mismatch",
    "denied",
    "timeout",
  ]) {
    const f = fixture(scenario),
      c = new CoreAccountController({
        stateDirectory: directory,
        executable: process.execPath,
        transport: f.transport,
        timeoutMs: scenario === "timeout" ? 100 : 5000,
      });
    t.after(() => c.dispose());
    c.login({ type: "chatgpt" });
    if (["mismatch", "denied"].includes(scenario)) {
      await until(() => c.snapshot().attempt?.status === "awaiting_browser");
      f.complete(
        scenario === "mismatch" ? "foreign" : "original-login-id",
        scenario !== "denied",
      );
    }
    await until(() => !c.busy);
    assert.equal(c.snapshot().attempt?.status, "failed", scenario);
    assert.equal(c.snapshot().account, null, scenario);
    assert.equal(f.closes(), 1, scenario);
    assert.ok(!JSON.stringify(c.snapshot()).includes("SECRET_FIXTURE"));
    assert.ok(!JSON.stringify(c.snapshot()).includes("secret-denial-text"));
  }
});

test("Account timeout and disposal release in-flight RPCs and retain the busy lock through cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-account-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const action of ["timeout", "cancel", "dispose"] as const) {
    let entered = false,
      closes = 0,
      release!: () => void,
      reject!: (e: Error) => void;
    const cleanup = new Promise<void>((r) => {
      release = r;
    });
    const pending = new Promise<never>((_, r) => {
      reject = r;
    });
    const c = new CoreAccountController({
      stateDirectory: directory,
      executable: process.execPath,
      timeoutMs: action === "timeout" ? 100 : 5000,
      transport(o) {
        return {
          async request<T>(method: string): Promise<T> {
            if (method === "initialize") return {} as T;
            assert.equal(method, "account/login/start");
            entered = true;
            return pending;
          },
          notify() {},
          respond() {},
          async close() {
            closes++;
            reject(new Error("secret RPC timeout detail"));
            o.onClose(new Error("closed") as never);
            await cleanup;
          },
        };
      },
    });
    t.after(async () => {
      release();
      await c.dispose();
    });
    const flow = c.login({ type: "chatgpt" });
    await until(() => entered);
    const end =
      action === "cancel"
        ? c.cancel(flow.attempt!.id)
        : action === "dispose"
          ? c.dispose()
          : undefined;
    await until(() => closes === 1);
    assert.equal(c.busy, true, "Still owns unsettled cleanup");
    assert.equal(
      c.snapshot().attempt?.status,
      action === "timeout" ? "failed" : "cancelled",
    );
    await assert.rejects(
      c.read(),
      action === "dispose" ? /closed/ : /pending account/,
    );
    release();
    await end;
    await until(() => !c.busy);
    assert.equal(closes, 1);
    assert.equal(c.snapshot().account, null);
    assert.ok(!JSON.stringify(c.snapshot()).includes("secret RPC"));
  }
});

test("A failed owned-process cleanup is explicit and cannot start a replacement account process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-account-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture("early");
  const c = new CoreAccountController({
    stateDirectory: dir,
    executable: process.execPath,
    transport(o) {
      const inner = f.transport(o);
      return {
        ...inner,
        async close() {
          await inner.close();
          throw new Error("private cleanup detail");
        },
      };
    },
  });
  t.after(() => c.dispose());
  c.login({ type: "apiKey", apiKey: "disposable" });
  await until(() => !!c.snapshot().cleanupError);
  assert.equal(c.snapshot().attempt?.code, "ACCOUNT_CLEANUP_FAILED");
  assert.equal(c.snapshot().attempt?.status, "failed");
  assert.equal(c.busy, true);
  await assert.rejects(c.read(), /Restart Synora/);
  assert.equal(f.closes(), 1);
  assert.ok(!JSON.stringify(c.snapshot()).includes("private cleanup detail"));
});

test("Cancel never exposes a raw cleanup error and still records the blocked owned-process state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-account-cancel-cleanup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture();
  const c = new CoreAccountController({
    stateDirectory: dir,
    executable: process.execPath,
    transport(o) {
      const inner = f.transport(o);
      return {
        ...inner,
        async close() {
          await inner.close();
          throw new Error("secret close error");
        },
      };
    },
  });
  t.after(() => c.dispose());
  const initial = c.login({ type: "chatgpt" });
  await until(() => c.snapshot().attempt?.status === "awaiting_browser");
  const result = await c.cancel(initial.attempt!.id);
  assert.equal(result.attempt?.code, "ACCOUNT_CLEANUP_FAILED");
  assert.ok(result.cleanupError);
  assert.ok(!JSON.stringify(result).includes("secret close error"));
  assert.equal(f.closes(), 1);
});
