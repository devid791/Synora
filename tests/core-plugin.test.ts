import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CorePluginManager } from "../src/engine/core-plugin";
import {
  AppServerError,
  type TransportOptions,
} from "../src/engine/app-server-transport";
import {
  pluginChangeReason,
  type CorePluginTarget,
} from "../src/shared/core-plugin";
import type { PluginDetail } from "../src/protocol/codex-0.153.4/v2/PluginDetail";
import type { prepareAxiomProcess } from "../src/engine/axiom-process";
type Prepared = Awaited<ReturnType<typeof prepareAxiomProcess>>;
const target: CorePluginTarget = {
  catalogId: "catalog",
  providerId: "provider",
  workspaceId: "workspace",
  marketplaceName: "personal",
  marketplacePath: "/owned/marketplace.json",
  pluginId: "proof@personal",
  pluginName: "proof",
  remotePluginId: null,
  configurationIdentity: "original-config",
};
const prepared = async (): Promise<Prepared> => ({
  executable: "controlled",
  cwd: "/owned",
  args: ["app-server", "--stdio"],
  env: {},
  models: [],
});
test("Public discovery is inspectable but cannot install before the account catalog grants eligibility", async () => {
  const f = fixture();
  const reviewed = await f.manager.inspect(
    { ...target, discoveryOnly: true },
    prepared,
  );
  assert.equal(reviewed.phase, "completed");
  const result = await f.manager.change(reviewed.id, "install", true, prepared);
  assert.equal(result.phase, "failed");
  assert.equal(result.error?.code, "PLUGIN_ACCOUNT_REQUIRED");
  assert.equal(result.mutationSent, false);
  assert.equal(f.processes.length, 1);
  assert.equal(
    f.calls.some((c) => c.method === "plugin/install"),
    false,
  );
});
function fixture() {
  const detail: PluginDetail = {
    marketplaceName: "personal",
    marketplacePath: target.marketplacePath,
    summary: {
      id: target.pluginId,
      name: target.pluginName,
      remotePluginId: null,
      version: null,
      localVersion: "1.0.0",
      shareContext: null,
      source: { type: "local", path: "/owned/plugin" },
      installed: false,
      installedAt: null,
      enabled: false,
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
    description: "Controlled protocol fixture",
    skills: [],
    hooks: [],
    apps: [],
    appTemplates: [],
    mcpServers: [],
    scheduledTasks: null,
  };
  const calls: { method: string; params: any }[] = [],
    processes: TransportOptions[] = [],
    rejected: unknown[] = [];
  let mode = "ok",
    closes = 0,
    rejectHeld: ((e: Error) => void) | undefined;
  const manager = new CorePluginManager((options) => {
    processes.push(options);
    return {
      async request<T>(
        method: string,
        params: unknown,
        timeout?: number,
      ): Promise<T> {
        calls.push({ method, params });
        assert.ok(timeout! > 0 && timeout! <= 30000);
        if (method === "initialize") {
          options.onRequest({ id: "unexpected", method: "item/tool/call" });
          return {} as T;
        }
        if (mode === "wait-read" && method === "plugin/read")
          return new Promise((_r, reject) => {
            rejectHeld = reject;
          });
        if (method === "plugin/read") {
          if (mode === "malformed") return { plugin: {} } as T;
          if (mode === "private-error")
            throw new AppServerError(401, "PRIVATE TOKEN MUST NOT LEAK");
          return { plugin: structuredClone(detail) } as T;
        }
        if (method === "plugin/install") {
          if (mode === "wait-mutation")
            return new Promise((_r, reject) => {
              rejectHeld = reject;
            });
          if (mode !== "postcondition") {
            detail.summary.installed = true;
            detail.summary.enabled = true;
          }
          return { authPolicy: "ON_INSTALL", appsNeedingAuth: [] } as T;
        }
        if (method === "plugin/uninstall") {
          detail.summary.installed = false;
          detail.summary.enabled = false;
          return {} as T;
        }
        throw Error(`Unexpected RPC ${method}`);
      },
      notify: (method) => assert.equal(method, "initialized"),
      respond: (id, data) => rejected.push({ id, data }),
      close: async () => {
        closes++;
        rejectHeld?.(Error("Owned transport closed"));
        if (mode === "cleanup") throw Error("Owned close failed");
      },
    };
  });
  return {
    manager,
    detail,
    calls,
    processes,
    rejected,
    closes: () => closes,
    mode: (s: string) => {
      mode = s;
    },
  };
}
test("Plugin original local/remote identities and explicit install/remove postconditions; no model calls", async () => {
  for (const remote of [false, true]) {
    const f = fixture();
    const selected = {
      ...target,
      marketplacePath: remote ? null : target.marketplacePath,
      remotePluginId: remote ? "plugin-remote-123" : null,
    };
    f.detail.marketplacePath = selected.marketplacePath;
    f.detail.summary.remotePluginId = selected.remotePluginId;
    const before = await f.manager.inspect(selected, prepared);
    assert.equal(before.phase, "completed");
    assert.throws(
      () => f.manager.change("stale", "install", true, prepared),
      /Inspect/,
    );
    assert.throws(
      () => f.manager.change(before.id, "install", false, prepared),
      /confirmation/,
    );
    assert.equal(f.processes.length, 1);
    const installed = await f.manager.change(
      before.id,
      "install",
      true,
      prepared,
    );
    assert.equal(installed.phase, "completed");
    assert.equal(installed.detail!.summary.installed, true);
    assert.throws(
      () => f.manager.change(installed.id, "install", true, prepared),
      /already installed/,
    );
    assert.deepEqual(
      f.calls.find((c) => c.method === "plugin/install")!.params,
      {
        pluginName: remote ? "plugin-remote-123" : "proof",
        ...(remote
          ? { remoteMarketplaceName: "personal" }
          : { marketplacePath: target.marketplacePath }),
        installAttemptId: installed.id,
      },
    );
    const removed = await f.manager.change(
      installed.id,
      "uninstall",
      true,
      prepared,
    );
    assert.equal(removed.phase, "completed");
    assert.equal(removed.detail!.summary.installed, false);
    assert.deepEqual(
      f.calls.find((c) => c.method === "plugin/uninstall")!.params,
      { pluginId: target.pluginId },
    );
    assert.equal(f.closes(), 3);
    assert.equal(f.manager.busy, false);
    assert.ok(f.calls.every((c) => /^(initialize|plugin\/)/.test(c.method)));
    assert.equal((f.rejected[0] as any).data.error.code, -32601);
    const copy = f.manager.snapshot()!;
    copy.detail!.summary.name = "changed";
    assert.equal(f.manager.snapshot()!.detail!.summary.name, "proof");
  }
});
test("Plugin review drift, identity mismatch and original policy deny changes before dispatch", async () => {
  for (const property of ["localVersion", "installPolicy"] as const) {
    const f = fixture();
    const review = await f.manager.inspect(target, prepared);
    if (property === "localVersion") f.detail.summary.localVersion = "2.0.0";
    else f.detail.summary.installPolicy = "NOT_AVAILABLE";
    const s = await f.manager.change(review.id, "install", true, prepared);
    assert.equal(s.error?.code, "PLUGIN_REVIEW_CHANGED");
    assert.equal(s.mutationSent, false);
    assert.equal(
      f.calls.some((c) => c.method === "plugin/install"),
      false,
    );
  }
  const f = fixture();
  f.detail.summary.id = "different";
  assert.equal(
    (await f.manager.inspect(target, prepared)).error?.code,
    "PLUGIN_IDENTITY",
  );
  f.detail.summary.installed = true;
  f.detail.summary.enabled = true;
  f.detail.summary.installPolicySource = "WORKSPACE_SETTING";
  assert.match(pluginChangeReason(f.detail, "uninstall")!, /managed/);
  f.detail.summary.availability = "DISABLED_BY_ADMIN";
  assert.match(pluginChangeReason(f.detail, "install")!, /unavailable/);
});
test("Plugin malformed/private errors and failed postconditions are not installation success", async () => {
  for (const mode of ["malformed", "private-error", "postcondition"]) {
    const f = fixture();
    const before = await f.manager.inspect(target, prepared);
    f.mode(mode);
    const s = await f.manager.change(before.id, "install", true, prepared);
    assert.equal(s.phase, mode === "postcondition" ? "uncertain" : "failed");
    assert.equal(JSON.stringify(s).includes("PRIVATE TOKEN"), false);
    assert.equal(s.busy, false);
    assert.throws(() => f.manager.reviewTarget(s.id), /Inspect/);
    if (mode === "postcondition")
      assert.equal(s.error?.code, "PLUGIN_POSTCONDITION");
  }
});
test("Plugin cancellation keeps exact identity and distinguishes before dispatch from uncertain mutation", async () => {
  for (const mode of ["wait-read", "wait-mutation"]) {
    const f = fixture();
    const before = await f.manager.inspect(target, prepared);
    f.mode(mode);
    const pending = f.manager.change(before.id, "install", true, prepared);
    for (
      let i = 0;
      i < 100 &&
      (mode === "wait-read"
        ? f.calls.length < 4
        : !f.calls.some((c) => c.method === "plugin/install"));
      i++
    )
      await delay(2);
    assert.equal(f.manager.busy, true);
    await assert.rejects(f.manager.cancel("stale"), /identity/);
    assert.throws(() => f.manager.inspect(target, prepared), /cleanup/);
    const result = await f.manager.cancel(f.manager.snapshot()!.id);
    await pending;
    assert.equal(
      result?.phase,
      mode === "wait-mutation" ? "uncertain" : "cancelled",
    );
    assert.equal(result?.mutationSent, mode === "wait-mutation");
    assert.equal(result?.busy, false);
  }
});
test("Plugin preparation cancellation releases owned resources without a process; failed cleanup stays locked", async () => {
  const f = fixture();
  let release!: (v: Prepared) => void,
    cleaned = 0;
  const pending = f.manager.inspect(
    target,
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const stopped = f.manager.cancel(f.manager.snapshot()!.id);
  release({
    ...(await prepared()),
    cleanup: async () => {
      cleaned++;
    },
  });
  assert.equal((await stopped)?.phase, "cancelled");
  await pending;
  assert.equal(cleaned, 1);
  assert.equal(f.processes.length, 0);
  f.mode("cleanup");
  const failed = await f.manager.inspect(target, prepared);
  assert.equal(failed.cleanupFailed, true);
  assert.equal(f.manager.busy, true);
  assert.throws(() => f.manager.inspect(target, prepared), /cleanup/);
});
test("Plugin install suppresses automatic browser OAuth only in the temporary process, using original quoted policy keys", async () => {
  const f = fixture();
  f.detail.mcpServers = ["server.with.dots", 'quoted"server'];
  const before = await f.manager.inspect(target, prepared);
  const installed = await f.manager.change(
    before.id,
    "install",
    true,
    prepared,
  );
  assert.equal(installed.phase, "completed");
  assert.deepEqual(f.processes[1].args.slice(2), [
    "-c",
    'plugins."proof@personal".mcp_servers."server.with.dots".enabled=false',
    "-c",
    'plugins."proof@personal".mcp_servers."quoted\\"server".enabled=false',
  ]);
  await f.manager.inspect(target, prepared);
  assert.deepEqual(f.processes[2].args, ["app-server", "--stdio"]);
  assert.deepEqual((await prepared()).args, ["app-server", "--stdio"]);
});
test("Plugin elapsed preparation prevents late RPC and cleanup still runs", async () => {
  let calls = 0,
    closes = 0;
  const manager = new CorePluginManager(
    () => ({
      request: async () => {
        calls++;
        return {} as any;
      },
      notify() {},
      respond() {},
      close: async () => {
        closes++;
      },
    }),
    1,
  );
  const state = await manager.inspect(target, async () => {
    await delay(8);
    return prepared();
  });
  assert.equal(calls, 0);
  assert.equal(closes, 1);
  assert.equal(state.error?.code, "PLUGIN_DEADLINE");
  assert.equal(state.phase, "failed");
});
