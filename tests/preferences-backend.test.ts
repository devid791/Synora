import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/main/store";
import { LocalService, type Host } from "../src/main/service";
import { validateOperation } from "../src/shared/operations";
import {
  EngineNotifications,
  lifecycleContent,
  loginItemHook,
  LoginItemApprovalRequired,
  nativePreferenceCapabilities,
} from "../src/main/native-preferences";
import type { EngineSnapshot, Result } from "../src/shared/contracts";

const bot = {
  schema: "synora.bot.v1",
  name: "Saved Bot",
  description: "",
  instructions: "Use the saved working style.",
  kind: "coding",
  profile: "max",
  context: 1048576,
  connectorIds: ["not-mounted"],
  enabled: true,
} as const;
const value = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
function storeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "synora-preferences-")),
    path = join(dir, "state.sqlite");
  let store = new Store(path);
  return {
    path,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new Store(path);
    },
    close() {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
function hostFixture(patch: Partial<Host> = {}): Host {
  return {
    capabilities: {
      platform: "web",
      transport: "local-http",
      nativeDialogs: false,
      terminal: true,
      embeddedBrowser: false,
      engine: "simulated",
      liveInference: false,
    },
    closeReady() {},
    chooseWorkspace: async () => null,
    importPreset: async () => null,
    exportPreset: async () => false,
    browser: {
      open: () => [],
      navigate() {},
      action: () => [],
      list: () => [],
      layout() {},
      dispose() {},
    },
    ...patch,
  };
}
test("Last selected conversation survives cold storage without rewriting histories or view", () => {
  const t = storeFixture();
  try {
    assert.equal(t.store.read().preferences.selectedConversationId, null);
    const a = t.store.conversation(null);
    t.store.draft(a.id, "KEEP_OLD_DRAFT");
    const b = t.store.conversation(null);
    assert.equal(t.store.read().preferences.selectedConversationId, b.id);
    const before = t.store.read().conversations;
    t.store.preferences({ selectedConversationId: a.id, view: "bots" });
    t.reopen();
    assert.equal(t.store.read().preferences.selectedConversationId, a.id);
    assert.equal(t.store.read().preferences.view, "bots");
    assert.deepEqual(t.store.read().conversations, before);
    for (const selectedConversationId of [42, "", "a".repeat(161)])
      assert.throws(() => validateOperation("preferences", [{ selectedConversationId }]));
  } finally { t.close(); }
});
test("New preferences validate, persist and survive restart with safe migration defaults", () => {
  const t = storeFixture();
  try {
    assert.equal(t.store.read().preferences.defaultBotId, null);
    assert.equal(t.store.read().preferences.theme, "system");
    assert.equal(t.store.read().preferences.busyEnterBehavior, "queue");
    assert.equal(t.store.read().preferences.launchAtLogin, false);
    assert.equal(t.store.read().preferences.systemNotifications, true);
    t.store.preferences({
      theme: "dark",
      busyEnterBehavior: "steer",
      launchAtLogin: true,
      systemNotifications: false,
    });
    t.reopen();
    assert.equal(t.store.read().preferences.theme, "dark");
    assert.equal(t.store.read().preferences.busyEnterBehavior, "steer");
    assert.equal(t.store.read().preferences.launchAtLogin, true);
    assert.equal(t.store.read().preferences.systemNotifications, false);
    for (const patch of [
      { theme: "red" },
      { busyEnterBehavior: "interrupt" },
      { launchAtLogin: "yes" },
      { systemNotifications: 1 },
      { defaultBotId: "" },
      { surprise: true },
    ])
      assert.throws(() => validateOperation("preferences", [patch]));
    assert.equal(
      validateOperation("preferences", [{}]).args[0] &&
        t.store.read().preferences.theme,
      "dark",
    );
  } finally {
    t.close();
  }
});
test("Global Bot/permission preferences never rewrite existing conversations, including before first Core turn", () => {
  const t = storeFixture();
  try {
    const saved = t.store.preset(bot).presets[0];
    t.store.preferences({ defaultBotId: saved.id, permission: "full" });
    const c = t.store.conversation(null);
    t.store.preferences({ defaultBotId: null, permission: "ask" });
    t.store.preset(
      { ...bot, instructions: "Changed after creation" },
      saved.id,
    );
    assert.deepEqual(t.store.read().conversations[0].defaults, {
      bot: saved,
      permission: "full",
    });
    const standard = t.store.conversation(null);
    assert.deepEqual(standard.defaults, { bot: null, permission: "ask" });
    t.reopen();
    assert.deepEqual(
      t.store.read().conversations.find((v) => v.id === c.id)!.defaults,
      c.defaults,
    );
    assert.throws(
      () => t.store.preferences({ defaultBotId: "missing" }),
      /enabled saved Bot/,
    );
    t.store.preferences({ defaultBotId: saved.id });
    t.store.preset({ ...bot, enabled: false }, saved.id);
    assert.equal(t.store.read().preferences.defaultBotId, null);
    assert.throws(
      () => t.store.preferences({ defaultBotId: saved.id }),
      /enabled saved Bot/,
    );
    assert.equal(
      t.store.read().conversations.find((v) => v.id === c.id)!.defaults!.bot!
        .enabled,
      true,
    );
  } finally {
    t.close();
  }
});
test("Legacy bound and pre-first-turn conversations freeze before a later settings edit", () => {
  const t = storeFixture();
  try {
    t.store.preferences({ permission: "full" });
    const old = t.store.conversation(null),
      fresh = t.store.conversation(null);
    t.store.update((s) => {
      for (const c of s.conversations) delete c.defaults;
      s.conversations.find((c) => c.id === old.id)!.binding = {
        threadId: "thread",
        sessionId: "session",
        cwd: "/owned",
        model: "model",
        endpoint: "http://localhost:1",
      };
    });
    t.reopen();
    t.store.preferences({ permission: "auto-review" });
    assert.equal(
      t.store.read().conversations.find((c) => c.id === old.id)!.defaults!
        .permission,
      "ask",
    );
    assert.equal(
      t.store.read().conversations.find((c) => c.id === fresh.id)!.defaults!
        .permission,
      "full",
    );
    assert.equal(
      t.store.conversation(null).defaults!.permission,
      "auto-review",
    );
  } finally {
    t.close();
  }
});
test("Missing preference fields migrate without mutating or losing legacy data", () => {
  const t = storeFixture();
  try {
    const db = new DatabaseSync(t.path);
    const state = t.store.read();
    for (const key of [
      "defaultBotId",
      "theme",
      "busyEnterBehavior",
      "launchAtLogin",
      "systemNotifications",
    ] as const)
      delete state.preferences[key];
    db.prepare("UPDATE state SET data=? WHERE id=1").run(JSON.stringify(state));
    db.close();
    t.reopen();
    assert.equal(t.store.read().preferences.launchAtLogin, false);
    assert.equal(t.store.read().preferences.systemNotifications, true);
  } finally {
    t.close();
  }
});
for (const platform of ["linux", "web"] as const)
  test(`${platform} explicitly reports absent native preference executors`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "synora-preferences-service-"));
    let calls = 0;
    const host = hostFixture({
      launchAtLogin: {
        read: () => {
          calls++;
          return false;
        },
        write: () => {
          calls++;
        },
      },
      notify: () => {
        calls++;
      },
    });
    host.capabilities.platform = platform;
    const service = new LocalService(
      join(dir, "state.sqlite"),
      host,
      () => {},
      1,
      { disabledReason: "CPU fixture" },
    );
    try {
      const capabilities = value(await service.api.capabilities());
      assert.equal(capabilities.launchAtLogin!.supported, false);
      assert.equal(capabilities.systemNotifications!.supported, false);
      assert.match(
        capabilities.launchAtLogin!.reason!,
        /No verified native executor/,
      );
      assert.equal(
        (await service.api.preferences({ launchAtLogin: true })).ok,
        false,
      );
      assert.equal(service.store.read().preferences.launchAtLogin, false);
      assert.equal(calls, 0);
    } finally {
      await service.dispose();
      rmSync(dir, { recursive: true });
    }
  });
test("Native preference changes are verified before persistence and roll back OS state on storage failure", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "synora-native-preferences-"));
  let enabled = false,
    theme = "system",
    failNative = false;
  const host = hostFixture({
    launchAtLogin: {
      read: () => enabled,
      write: (value) => {
        if (failNative) throw Error("OS refused");
        enabled = value;
      },
    },
    setTheme: (v) => {
      theme = v;
    },
    notify() {},
  });
  host.capabilities.platform = "darwin";
  const service = new LocalService(
    join(dir, "state.sqlite"),
    host,
    () => {},
    1,
    { disabledReason: "CPU fixture" },
  );
  try {
    value(
      await service.api.preferences({ launchAtLogin: true, theme: "dark" }),
    );
    assert.equal(enabled, true);
    assert.equal(theme, "dark");
    failNative = true;
    assert.equal(
      (await service.api.preferences({ launchAtLogin: false })).ok,
      false,
    );
    assert.equal(service.store.read().preferences.launchAtLogin, true);
    failNative = false;
    const original = service.store.preferences.bind(service.store);
    const mock = ctx.mock.method(service.store, "preferences", () => {
      throw Error("controlled storage failure");
    });
    assert.equal(
      (await service.api.preferences({ launchAtLogin: false, theme: "light" }))
        .ok,
      false,
    );
    assert.equal(enabled, true);
    assert.equal(theme, "dark");
    mock.mock.restore();
    original({ systemNotifications: false });
    value(await service.api.preferences({ permission: "full" }));
    assert.equal(service.store.read().preferences.systemNotifications, false);
  } finally {
    await service.dispose();
    rmSync(dir, { recursive: true });
  }
});
test("A pending macOS login-item approval is retained without persisting false success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-login-approval-")),
    writes: boolean[] = [];
  const host = hostFixture({
    launchAtLogin: {
      read: () => false,
      write: (enabled) => {
        writes.push(enabled);
        throw new LoginItemApprovalRequired();
      },
    },
  });
  host.capabilities.platform = "darwin";
  const service = new LocalService(
    join(dir, "state.sqlite"),
    host,
    () => {},
    1,
    { disabledReason: "CPU fixture" },
  );
  try {
    const response = await service.api.preferences({ launchAtLogin: true });
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.error.message, /requires approval/);
    assert.deepEqual(writes, [true]);
    assert.equal(service.store.read().preferences.launchAtLogin, false);
  } finally {
    await service.dispose();
    rmSync(dir, { recursive: true });
  }
});
for (const platform of ["darwin", "win32"] as const)
  test(`${platform} login item hook uses exact executable and verifies OS acknowledgement`, () => {
    let enabled = false,
      blocked = false;
    const writes: unknown[] = [],
      reads: unknown[] = [];
    const app = {
      getLoginItemSettings: (query: unknown) => {
        reads.push(query);
        return {
          openAtLogin: enabled,
          executableWillLaunchAtLogin: enabled && !blocked,
          status: blocked ? "requires-approval" : "enabled",
        };
      },
      setLoginItemSettings: (settings: { openAtLogin: boolean }) => {
        writes.push(settings);
        enabled = settings.openAtLogin;
      },
    };
    const hook = loginItemHook(app as any, platform, "/owned/Synora.exe");
    hook.write(true);
    assert.equal(hook.read(), true);
    hook.write(false);
    assert.equal(hook.read(), false);
    if (platform === "win32")
      assert.deepEqual(writes[0], {
        path: "/owned/Synora.exe",
        args: [],
        openAtLogin: true,
        enabled: true,
      });
    else assert.deepEqual(writes[0], { openAtLogin: true });
    blocked = true;
    assert.throws(
      () => hook.write(true),
      platform === "darwin" ? /requires approval/ : /did not confirm/,
    );
  });
const snapshot = (patch: Partial<EngineSnapshot> = {}): EngineSnapshot => ({
  connection: "live",
  appServer: { phase: "ready", attempts: 0 },
  status: "idle",
  threadId: "thread",
  sessionId: "session",
  turnId: null,
  items: [],
  agents: [],
  approval: null,
  sequence: 1,
  ...patch,
});
test("Core crash/repeated connection failure notifications dedupe, recover and never contain source data", () => {
  const events: string[] = [];
  const notifications = new EngineNotifications(
    () => true,
    (kind) => events.push(JSON.stringify(lifecycleContent[kind])),
  );
  notifications.observe(snapshot());
  const offline = snapshot({
    connection: "disconnected",
    appServer: {
      phase: "offline",
      attempts: 1,
      message: "PRIVATE_SECRET /private/workspace prompt content",
    },
  });
  notifications.observe(offline);
  notifications.observe(offline);
  assert.equal(events.length, 1);
  notifications.observe(snapshot());
  notifications.observe(snapshot());
  assert.equal(events.length, 2);
  assert.ok(
    events.every(
      (text) => !/PRIVATE_SECRET|workspace|prompt content/.test(text),
    ),
  );
  notifications.dispose();
  notifications.observe(offline);
  assert.equal(events.length, 2);
  const initial: string[] = [],
    starting = new EngineNotifications(
      () => true,
      (kind) => initial.push(kind),
    );
  starting.observe({
    ...offline,
    appServer: { ...offline.appServer!, attempts: 1 },
  });
  starting.observe({
    ...offline,
    appServer: { ...offline.appServer!, attempts: 2 },
  });
  assert.equal(initial.length, 0);
  starting.observe({
    ...offline,
    appServer: { ...offline.appServer!, attempts: 3 },
  });
  starting.observe({
    ...offline,
    appServer: { ...offline.appServer!, attempts: 4 },
  });
  assert.deepEqual(initial, ["core-unavailable"]);
});
test("Distinct failed turns notify once, historical duplicates and cancellation do not, successful turn recovers", () => {
  const events: string[] = [],
    notifications = new EngineNotifications(
      () => true,
      (kind) => events.push(kind),
    );
  for (let n = 1; n <= 5; n++) {
    notifications.observe(snapshot({ turnId: `turn-${n}`, status: "failed" }));
    notifications.observe(snapshot({ turnId: `turn-${n}`, status: "failed" }));
  }
  assert.deepEqual(events, ["turn-failures"]);
  notifications.observe(snapshot({ turnId: "success", status: "completed" }));
  notifications.observe(snapshot({ turnId: "turn-1", status: "failed" }));
  notifications.observe(
    snapshot({ turnId: "cancelled", status: "interrupted" }),
  );
  assert.deepEqual(events, ["turn-failures", "recovered"]);
  const muted = new EngineNotifications(
    () => false,
    () => {
      throw Error("Must stay silent");
    },
  );
  for (let n = 0; n < 5; n++)
    muted.observe(snapshot({ status: "failed", turnId: String(n) }));
  muted.observe(snapshot({ status: "completed", turnId: "recovery" }));
  assert.equal(
    nativePreferenceCapabilities("darwin", {}).systemNotifications.supported,
    false,
  );
});
test("Busy submission accepts only the exact typed Core preconditions", () => {
  const busy = {
    behavior: "steer",
    expectedThreadId: "thread",
    expectedTurnId: "turn",
  };
  assert.deepEqual(
    validateOperation("engineStart", ["conversation", "text", "text", busy])
      .args[3],
    busy,
  );
  assert.throws(() =>
    validateOperation("engineStart", [
      "conversation",
      "text",
      "text",
      { behavior: "steer" },
    ]),
  );
  assert.throws(() =>
    validateOperation("engineStart", [
      "conversation",
      "text",
      "text",
      { ...busy, command: "shell" },
    ]),
  );
  assert.equal(
    validateOperation("engineStart", ["conversation", "text", "text"]).args
      .length,
    3,
  );
});
