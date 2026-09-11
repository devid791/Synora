import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { McpAuthorizationController } from "../src/engine/mcp-authorization";
import type { TransportOptions } from "../src/engine/app-server-transport";
const plugin = {
  id: "proof@personal",
  name: "proof",
  marketplaceName: "personal",
  marketplacePath: "/owned/marketplace.json",
  serverName: "proof",
};
test("Plugin preparation cleanup failure remains visible and blocks reuse after cancellation or constructor failure", async () => {
  for (const mode of ["cancel", "constructor"]) {
    const controller = new McpAuthorizationController();
    let release!: (value: any) => void,
      cleanups = 0;
    const prepared = {
      executable: "fixture",
      cwd: "/owned",
      env: {},
      args: [],
      cleanup: async () => {
        cleanups++;
        throw Error("private cleanup details");
      },
    };
    const options = {
      plugin,
      providerId: "owned",
      prepare: () =>
        new Promise<typeof prepared>((resolve) => {
          release = resolve;
        }),
      transport: () => {
        throw Error("constructor failed");
      },
    };
    const state = controller.start(options);
    const cancelled = mode === "cancel" ? controller.cancel(state.id) : null;
    release(prepared);
    if (cancelled) await cancelled;
    else {
      for (
        let i = 0;
        i < 200 && controller.snapshot()?.status === "starting";
        i++
      )
        await delay(2);
      await controller.cancel(state.id);
    }
    assert.equal(cleanups, 1);
    assert.equal(controller.snapshot()?.status, "failed");
    assert.equal(controller.snapshot()?.code, "OAUTH_CLEANUP_FAILED");
    assert.equal(controller.snapshot()?.cleanupFailed, true);
    assert.equal(controller.busy, true);
    assert.equal(controller.snapshot()?.authorizationUrl, undefined);
    assert.ok(
      !JSON.stringify(controller.snapshot()).includes(
        "private cleanup details",
      ),
    );
    assert.throws(() => controller.start(options), /pending browser sign-in/);
    await controller.dispose();
    assert.equal(cleanups, 1);
  }
});
function fixture(mode: string) {
  let options!: TransportOptions,
    closes = 0;
  const calls: { method: string; params: any }[] = [];
  const detail = {
    marketplaceName: "personal",
    marketplacePath: plugin.marketplacePath,
    summary: {
      id: mode === "wrong-plugin" ? "other@personal" : plugin.id,
      name: "proof",
      remotePluginId: null,
      version: null,
      localVersion: "1.0.0",
      shareContext: null,
      source: { type: "local", path: "/owned/plugin" },
      installed: mode !== "uninstalled",
      installedAt: null,
      enabled: true,
      installPolicy: "AVAILABLE",
      installPolicySource: null,
      mustShowInstallationInterstitial: null,
      authPolicy: "ON_INSTALL",
      availability: "AVAILABLE",
      disabledReason: null,
      eligiblePlanTypes: null,
      interface: null,
      keywords: [],
    },
    shareUrl: null,
    description: "Protocol fixture only",
    skills: [],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: ["proof"],
    scheduledTasks: null,
  };
  const transport = (o: TransportOptions) => {
    options = o;
    return {
      async request<T>(method: string, params: unknown): Promise<T> {
        calls.push({ method, params });
        if (method === "initialize") return {} as T;
        if (method === "plugin/read") return { plugin: detail } as T;
        if (method === "mcpServerStatus/list")
          return {
            data: [
              {
                name: "proof",
                pluginId:
                  mode === "foreign-runtime" ? "another@personal" : plugin.id,
                runtimeStatus: null,
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                authStatus: "notLoggedIn",
              },
            ],
            nextCursor: mode === "cursor-loop" ? "repeat" : null,
          } as T;
        assert.equal(method, "mcpServer/oauth/login");
        return {
          authorizationUrl:
            "https://fixture.invalid/authorize?state=CONTROLLED",
        } as T;
      },
      notify() {},
      respond() {},
      close: async () => {
        closes++;
        if (mode === "cleanup") throw Error("Close failed");
      },
    };
  };
  return {
    transport,
    calls,
    closes: () => closes,
    complete: () =>
      options.onNotification({
        method: "mcpServer/oauthLogin/completed",
        params: { name: "proof", threadId: null, success: true },
      }),
  };
}
test("Plugin authorization validates current original plugin and runtime owner before exposing a URL; preparation owns cleanup", async () => {
  for (const mode of [
    "ok",
    "wrong-plugin",
    "uninstalled",
    "foreign-runtime",
    "cursor-loop",
    "cleanup",
  ]) {
    const f = fixture(mode),
      controller = new McpAuthorizationController();
    const state = controller.start({
      plugin,
      providerId: "owned",
      prepare: async () => ({
        executable: "fixture",
        args: [],
        cwd: "/owned",
        env: {},
      }),
      transport: f.transport,
      timeoutMs: 3000,
    });
    for (
      let i = 0;
      i < 200 && controller.snapshot()?.status === "starting";
      i++
    )
      await delay(2);
    if (mode === "ok" || mode === "cleanup") {
      assert.equal(controller.snapshot()?.status, "awaiting_browser");
      assert.equal(controller.snapshot()?.pluginId, plugin.id);
      assert.equal(controller.snapshot()?.busy, true);
      assert.deepEqual(
        f.calls.find((c) => c.method === "mcpServer/oauth/login")!.params,
        { name: "proof", timeoutSecs: 3 },
      );
      f.complete();
    }
    for (
      let i = 0;
      i < 200 &&
      controller.snapshot()?.busy &&
      !controller.snapshot()?.cleanupFailed;
      i++
    )
      await delay(2);
    assert.equal(
      controller.snapshot()?.status,
      mode === "ok" ? "authorized" : "failed",
    );
    assert.equal(
      f.calls.some((c) => c.method === "mcpServer/oauth/login"),
      mode === "ok" || mode === "cleanup",
    );
    assert.equal(f.closes(), 1);
    assert.equal(controller.snapshot()?.id, state.id);
    if (mode === "cleanup") {
      assert.equal(controller.snapshot()?.code, "OAUTH_CLEANUP_FAILED");
      assert.equal(controller.busy, true);
    } else assert.equal(controller.busy, false);
    await controller.dispose();
  }
});
test("Plugin login cancelled during asynchronous preparation cleans the resource without starting Core", async () => {
  const c = new McpAuthorizationController();
  let release!: (v: any) => void,
    closed = 0;
  const flow = c.start({
    providerId: "owned",
    plugin,
    prepare: () =>
      new Promise((r) => {
        release = r;
      }),
    transport: () => {
      throw Error("Must not start");
    },
  });
  const pending = c.cancel(flow.id);
  release({
    executable: "fixture",
    cwd: "/owned",
    env: {},
    args: [],
    cleanup: async () => {
      closed++;
    },
  });
  const result = await pending;
  assert.equal(result.status, "cancelled");
  assert.equal(result.busy, false);
  assert.equal(closed, 1);
  await c.dispose();
});
test("Plugin failed transport construction releases its prepared resources", async () => {
  const c = new McpAuthorizationController();
  let cleaned = 0;
  c.start({
    providerId: "owned",
    plugin,
    prepare: async () => ({
      executable: "fixture",
      cwd: "/owned",
      env: {},
      args: [],
      cleanup: async () => {
        cleaned++;
      },
    }),
    transport: () => {
      throw Error("Constructor failed");
    },
  });
  for (let i = 0; i < 100 && c.busy; i++) await delay(2);
  assert.equal(cleaned, 1);
  assert.equal(c.snapshot()?.status, "failed");
  assert.equal(c.busy, false);
  await c.dispose();
});
