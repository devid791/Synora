import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { McpAuthorizationController } from "../src/engine/mcp-authorization";
import type { TransportOptions } from "../src/engine/app-server-transport";
import { oauthBrowserUrl } from "../src/shared/oauth-url";
import { configSchema } from "../src/shared/contracts";
import { mcpConfiguration } from "../src/engine/mcp-config";

const integration = {
  id: "fixture-auth",
  name: "Local OAuth fixture",
  kind: "mcp" as const,
  executor: "http-mcp" as const,
  enabled: true,
  auth: "oauth" as const,
  endpoint: "http://127.0.0.1:12345/mcp",
  tools: [],
};
function fixture(scenario = "normal") {
  let options!: TransportOptions,
    closes = 0;
  const calls: { method: string; params?: unknown }[] = [];
  const complete = (
    params: unknown = {
      name: "synora_fixture_auth",
      threadId: null,
      success: true,
    },
  ) =>
    options.onNotification({
      method: "mcpServer/oauthLogin/completed",
      params,
    });
  return {
    transport: (o: TransportOptions) => {
      options = o;
      return {
        async request<T>(method: string, params?: unknown): Promise<T> {
          calls.push({ method, params });
          if (method === "initialize") return {} as T;
          assert.equal(method, "mcpServer/oauth/login");
          if (scenario === "rpc-error")
            throw new Error("access_token=DO_NOT_ECHO_THIS");
          if (scenario === "early-success") complete();
          return (
            scenario === "malformed"
              ? { bad: true }
              : {
                  authorizationUrl:
                    scenario === "unsafe"
                      ? "javascript:alert(1)"
                      : "https://oauth.example.invalid/authorize?state=fixture-only",
                }
          ) as T;
        },
        notify(method: string) {
          calls.push({ method });
        },
        respond() {
          throw new Error("No model requests in OAuth test");
        },
        async close() {
          closes++;
          o.onClose(new Error("Closed") as never);
        },
      };
    },
    complete,
    calls,
    options: () => options,
    closes: () => closes,
  };
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(5);
  }
  assert.fail("Expected OAuth state was not reached");
}
test("HTTP MCP OAuth is isolated and does not enable API-key or stdio authentication by accident", async () => {
  assert.ok(configSchema.safeParse(integration).success);
  assert.equal(
    configSchema.safeParse({ ...integration, auth: "api-key" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({
      ...integration,
      endpoint: "http://public.example/mcp",
    }).success,
    false,
  );
  const config = await mcpConfiguration([integration]);
  assert.equal(config.mcp_oauth_credentials_store, "file");
  assert.equal(
    config["mcp_servers.synora_fixture_auth.url"],
    integration.endpoint,
  );
  for (const u of [
    "javascript:alert(1)",
    "file:///tmp/oauth",
    "http://example.com/auth",
    "https://a:b@example.com",
  ])
    assert.throws(() => oauthBrowserUrl(u));
  assert.equal(
    oauthBrowserUrl("http://127.0.0.1:123/callback"),
    "http://127.0.0.1:123/callback",
  );
});
test("OAuth URL is not success; exact original terminal identity is required, without inference", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-auth-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let authorized = 0;
  const c = new McpAuthorizationController(() => authorized++),
    f = fixture();
  t.after(() => c.dispose());
  const options = {
    integration,
    providerId: "axiom",
    stateDirectory: dir,
    executable: process.execPath,
    transport: f.transport,
  };
  const first = c.start(options);
  assert.equal(first.status, "starting");
  assert.throws(() => c.start(options), /pending browser/);
  await until(() => c.snapshot()?.status === "awaiting_browser");
  assert.match(c.url(first.id), /^https:\/\/oauth.example.invalid/);
  assert.equal(authorized, 0);
  assert.equal(f.options().env.CODEX_HOME, dir);
  assert.equal(f.options().cwd, dir);
  assert.equal(f.options().env.OPENAI_API_KEY, undefined);
  assert.ok(f.options().args.includes('mcp_oauth_credentials_store="file"'));
  assert.deepEqual(
    f.calls.map((v) => v.method),
    ["initialize", "initialized", "mcpServer/oauth/login"],
  );
  assert.equal(
    (f.calls.at(-1)?.params as { name: string }).name,
    "synora_fixture_auth",
  );
  await assert.rejects(c.cancel("wrong"), /Stale/);
  f.complete();
  await until(() => !c.busy);
  assert.equal(c.snapshot()?.status, "authorized");
  assert.equal(c.snapshot()?.authorizationUrl, undefined);
  assert.equal(authorized, 1);
  assert.equal(f.closes(), 1);
  assert.throws(() => c.url(first.id), /No matching/);
});
test("OAuth rejects malformed, foreign, denied and unsafe flows; timeout/cancel close only owned process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-auth-negative-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const scenario of [
    "malformed",
    "unsafe",
    "rpc-error",
    "early-success",
    "wrong-name",
    "wrong-thread",
    "bad-event",
    "denied",
    "timeout",
    "cancel",
  ]) {
    const c = new McpAuthorizationController(),
      f = fixture(scenario);
    const first = c.start({
      integration,
      providerId: "axiom",
      stateDirectory: dir,
      executable: process.execPath,
      transport: f.transport,
      timeoutMs: scenario === "timeout" ? 70 : 2000,
    });
    if (
      ![
        "malformed",
        "unsafe",
        "rpc-error",
        "early-success",
        "timeout",
      ].includes(scenario)
    ) {
      await until(() => c.snapshot()?.status === "awaiting_browser");
      if (scenario === "cancel") await c.cancel(first.id);
      else
        f.complete(
          scenario === "bad-event"
            ? { name: "synora_fixture_auth", success: "yes" }
            : {
                name:
                  scenario === "wrong-name" ? "foreign" : "synora_fixture_auth",
                threadId: scenario === "wrong-thread" ? "foreign-thread" : null,
                success: scenario !== "denied",
                error: "sensitive-token-DO_NOT_ECHO",
              },
        );
    }
    await until(() => !c.busy);
    assert.equal(
      c.snapshot()?.status,
      scenario === "early-success"
        ? "authorized"
        : scenario === "cancel"
          ? "cancelled"
          : "failed",
      scenario,
    );
    const terminal = c.snapshot();
    f.complete(); // Late success must not resurrect a timed-out/cancelled flow.
    assert.deepEqual(c.snapshot(), terminal);
    assert.ok(!JSON.stringify(terminal).includes("DO_NOT_ECHO"));
    assert.equal(f.closes(), 1, scenario);
    await c.dispose();
    assert.throws(
      () => c.start({ integration, providerId: "axiom", stateDirectory: dir }),
      /closed/,
    );
  }
});
