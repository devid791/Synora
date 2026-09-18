import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreUpdater } from "../src/engine/core-updater";
import {
  qualifiedCore,
  compareCoreVersions,
} from "../src/engine/qualified-core";
import { updaterFixture } from "./core-updater-fixture";
import { Store } from "../src/main/store";
test("Fresh release starts on the current bundle while saved legacy selections remain intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synora-current-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fresh = new CoreUpdater(root);
  assert.equal(fresh.selection().version, "0.154.0");
  assert.equal(fresh.snapshot().eligibleVersion, null);
  await fresh.dispose();
  await mkdir(join(root, "runtime-updates"));
  const retained = {active:{version:"0.153.4",generation:null},previous:null,recoveryId:null,
    automatic:false,latestVersion:null,checkedAt:null,checks:[]};
  const path = join(root, "runtime-updates/active.json"), bytes = JSON.stringify(retained);
  await writeFile(path, bytes);
  const reopened = new CoreUpdater(root);
  try {
    assert.equal(reopened.selection().version, "0.153.4");
    assert.equal(reopened.snapshot().eligibleVersion, "0.154.0");
    assert.equal(reopened.snapshot().automatic, false);
    assert.equal(await readFile(path, "utf8"), bytes);
  } finally { await reopened.dispose(); }
});
test("dispose aborts a pending download; concurrent install cannot pass admission", async (t) => {
  const f = await setup(t);
  let started!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  const updater = new CoreUpdater(f.home, {
    ...f.options,
    archive: async (_r, _d, signal) =>
      new Promise<string>((_resolve, reject) => {
        started();
        signal.addEventListener(
          "abort",
          () => reject(Error("download aborted")),
          { once: true },
        );
      }),
  });
  t.after(() => updater.dispose());
  const rejected = assert.rejects(
    updater.install("0.153.5", f.hooks),
    /download aborted/,
  );
  await began;
  assert.throws(
    () => updater.install("0.153.5", f.hooks),
    /Wait for the runtime operation/,
  );
  await updater.dispose();
  await rejected;
  assert.equal(updater.snapshot().currentVersion, "0.153.4");
  assert.equal(f.counts().paused, 0);
});
test("download path verifies exact bytes and cancels/removes oversized partial data", async (t) => {
  const f = await setup(t);
  const data = await readFile(f.releases.get("0.153.5")!.archive);
  let oversize = true;
  const urls: string[] = [];
  const updater = new CoreUpdater(f.home, {
    ...f.options,
    archive: undefined,
    fetch: (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        Uint8Array.from(oversize ? Buffer.alloc(data.length + 1) : data),
      );
    }) as typeof fetch,
  });
  t.after(() => updater.dispose());
  await assert.rejects(
    updater.install("0.153.5", f.hooks),
    /exceeds qualified size/,
  );
  assert.deepEqual(
    await readdir(join(f.home, "runtime-updates/archives/0.153.5")),
    [],
  );
  assert.equal(f.counts().paused, 0);
  oversize = false;
  await updater.install("0.153.5", f.hooks);
  assert.equal(updater.snapshot().currentVersion, "0.153.5");
  assert.ok(
    urls.every((u) =>
      u.startsWith(
        "https://github.com/openai/codex/releases/download/rust-v0.153.5/",
      ),
    ),
  );
});
test("data ownership prevents a second service racing update snapshots and releases on close", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-update-lease-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite"),
    store = new Store(path);
  try {
    assert.throws(() => new Store(path), /already owned/);
    const saved = store.read();
    store.preferences({ compact: true });
    const revision = store.read().revision;
    store.restoreSnapshot(saved);
    assert.equal(store.read().preferences.compact, false);
    assert.equal(store.read().revision, revision + 1);
  } finally {
    store.close();
  }
  const reopened = new Store(path);
  reopened.close();
});
async function setup(
  t: { after: (f: () => Promise<void>) => void },
  broken = false,
) {
  const root = await mkdtemp(join(tmpdir(), "synora-update-test-"));
  const f = await updaterFixture(root, broken),
    home = join(root, "app");
  await mkdir(join(home, "app-server", "fixture"), { recursive: true });
  await writeFile(
    join(home, "app-server", "fixture", "history.json"),
    "old-thread-and-session",
  );
  await mkdir(join(home, "provider-credentials"));
  await writeFile(
    join(home, "provider-credentials", "private"),
    "must-not-change",
  );
  let appState = { session: "original", draft: "saved" },
    paused = 0,
    resumed = 0;
  const hooks = {
    idle: () => {},
    pause: async () => {
      paused++;
    },
    resume: () => {
      resumed++;
    },
    state: () => ({ ...appState }),
    restore: (s: unknown) => {
      appState = s as typeof appState;
    },
  };
  const updater = new CoreUpdater(home, f.options);
  t.after(async () => {
    await updater.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...f,
    root,
    home,
    hooks,
    updater,
    counts: () => ({ paused, resumed }),
    state: () => appState,
    mutate: () => {
      appState = { session: "new", draft: "new" };
    },
  };
}
test("upstream discovery is not qualification; checks coalesce, persist and never install", async (t) => {
  const f = await setup(t);
  let calls = 0;
  const messages: string[] = [];
  const updater = new CoreUpdater(f.home, {
    ...f.options,
    available: [],
    fetch: (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({
        tag_name: "rust-v0.153.6",
        draft: false,
        prerelease: false,
      });
    }) as typeof fetch,
    notify: (m) => messages.push(m),
  });
  t.after(() => updater.dispose());
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(calls, 1);
  assert.equal(messages.length, 1);
  const s = updater.snapshot();
  assert.equal(s.latestVersion, "0.153.6");
  assert.equal(s.currentVersion, "0.153.4");
  assert.equal(s.eligibleVersion, null);
  assert.equal(s.checking, false);
  await updater.check();
  assert.equal(messages.length, 1);
  await updater.automatic(false);
  const reopened = new CoreUpdater(f.home, f.options);
  t.after(() => reopened.dispose());
  assert.equal(reopened.snapshot().automatic, false);
  assert.equal(reopened.snapshot().latestVersion, "0.153.6");
  assert.equal(f.counts().paused, 0);
});
test("automatic discovery notifies without a settings view or inference", async (t) => {
  const f = await setup(t);
  let notify!: () => void;
  const done = new Promise<void>((r) => {
    notify = r;
  });
  const updater = new CoreUpdater(f.home, {
    ...f.options,
    notify: () => notify(),
  });
  t.after(() => updater.dispose());
  updater.start();
  await Promise.race([
    done,
    new Promise((_, r) => setTimeout(() => r(Error("No notification")), 1000)),
  ]);
  assert.equal(updater.snapshot().currentVersion, "0.153.4");
});
test("automatic updates really install an eligible payload only after idle admission", async (t) => {
  const f = await setup(t);
  let busy = true;
  const updater = new CoreUpdater(f.home, {
    ...f.options,
    initialDelayMs: 1,
    idleRetryMs: 10,
    intervalMs: 100000,
  });
  t.after(() => updater.dispose());
  updater.start({
    ...f.hooks,
    idle: () => {
      if (busy) throw Error("active turn");
    },
  });
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > deadline) throw Error("Automatic update did not settle");
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  await until(() => updater.snapshot().message.includes("queued"));
  assert.equal(updater.snapshot().currentVersion, "0.153.4");
  assert.equal(f.counts().paused, 0);
  busy = false;
  await until(
    () => updater.snapshot().currentVersion === "0.153.5" && !updater.busy,
  );
  assert.equal(updater.snapshot().previousVersion, "0.153.4");
  assert.deepEqual(f.counts(), { paused: 1, resumed: 1 });
});
test("Failed automatic version stays suppressed after restart, without hiding manual recovery", async (t) => {
  const f = await setup(t);
  let attempts = 0;
  const options = {
    ...f.options,
    initialDelayMs: 1,
    intervalMs: 10,
    archive: async () => {
      attempts++;
      throw Error("Controlled download failure");
    },
  };
  const updater = new CoreUpdater(f.home, options);
  updater.start(f.hooks);
  const deadline = Date.now() + 2000;
  for (;;) {
    let persisted = false;
    try {
      persisted =
        JSON.parse(
          await readFile(
            join(f.home, "runtime-updates", "active.json"),
            "utf8",
          ),
        ).failedAutomaticVersion === "0.153.5";
    } catch {}
    if (persisted && !updater.busy) break;
    assert.ok(Date.now() < deadline, "Failure marker was not saved");
    await new Promise((r) => setTimeout(r, 10));
  }
  await updater.dispose();
  assert.equal(attempts, 1);
  const reopened = new CoreUpdater(f.home, options);
  try {
    reopened.start(f.hooks);
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(attempts, 1);
    assert.equal(reopened.snapshot().currentVersion, "0.153.4");
    assert.equal(reopened.snapshot().eligibleVersion, "0.153.5");
  } finally {
    await reopened.dispose();
  }
});
test("unqualified, stale and active-session installs reject without touching data", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.updater.install("9.9.9", f.hooks), /Not qualified/);
  assert.throws(
    () =>
      f.updater.install("0.153.5", {
        ...f.hooks,
        idle: () => {
          throw Error("active turn");
        },
      }),
    /active turn/,
  );
  assert.equal(f.counts().paused, 0);
  assert.equal(
    await readFile(join(f.home, "app-server/fixture/history.json"), "utf8"),
    "old-thread-and-session",
  );
  assert.throws(() => qualifiedCore("0.153.5"), /No uniquely qualified/);
  assert.equal(compareCoreVersions("0.154.0", "0.153.10") > 0, true);
  assert.throws(() => compareCoreVersions("0.153.4-beta", "0.153.4"));
});
test("qualified install verifies real archive/helpers/process; keeps stable homes, cold selection and recovery", async (t) => {
  const f = await setup(t);
  const selected = await f.updater.install("0.153.5", f.hooks);
  assert.equal(selected.currentVersion, "0.153.5");
  assert.equal(selected.previousVersion, "0.153.4");
  assert.equal(selected.checks.length, 3);
  assert.equal(f.updater.dataRoot, f.home);
  assert.equal(f.updater.selection().version, "0.153.5");
  const cold = new CoreUpdater(f.home, f.options);
  t.after(() => cold.dispose());
  assert.equal(cold.snapshot().currentVersion, "0.153.5");
  assert.equal(cold.snapshot().checks.length, 3);
  assert.match(await cold.selection().executable(), /0\.153\.5/);
  f.mutate();
  await writeFile(
    join(f.home, "app-server/fixture/history.json"),
    "new-history",
  );
  // A previously absent account directory must also recover to an empty copy.
  await mkdir(join(f.home, "accounts"));
  await writeFile(join(f.home, "accounts/new"), "new-account-data");
  const result = await f.updater.rollback(selected.recoveryId!, f.hooks);
  assert.equal(result.currentVersion, "0.153.4");
  assert.equal(result.recoveryId, null);
  assert.deepEqual(f.state(), { session: "original", draft: "saved" });
  assert.equal(
    await readFile(join(f.home, "app-server/fixture/history.json"), "utf8"),
    "old-thread-and-session",
  );
  assert.deepEqual(await readdir(join(f.home, "accounts")), []);
  assert.equal(
    await readFile(
      join(
        f.home,
        "runtime-updates/generations",
        selected.recoveryId!,
        "after-upgrade/app-server/fixture/history.json",
      ),
      "utf8",
    ),
    "new-history",
  );
  assert.equal(
    await readFile(join(f.home, "provider-credentials/private"), "utf8"),
    "must-not-change",
  );
  assert.deepEqual(f.counts(), { paused: 2, resumed: 2 });
});
test("corrupt archive and failed initialize keep prior binary and data active", async (t) => {
  const f = await setup(t, true);
  await assert.rejects(
    f.updater.install("0.153.5", f.hooks),
    /Invalid App Server initialize/,
  );
  assert.equal(f.updater.snapshot().currentVersion, "0.153.4");
  assert.equal(f.updater.snapshot().phase, "failed");
  assert.deepEqual(f.counts(), { paused: 1, resumed: 1 });
  const archive = f.releases.get("0.153.5")!.archive;
  await writeFile(archive, "broken");
  // New owned root so the verified, already installed cache cannot mask corruption.
  const other = new CoreUpdater(join(f.root, "corrupt"), f.options);
  t.after(() => other.dispose());
  await assert.rejects(other.install("0.153.5", f.hooks), /integrity mismatch/);
  assert.equal(other.snapshot().currentVersion, "0.153.4");
});
test("snapshot excludes regenerated arg0 aliases, retains history and supports rollback", async (t) => {
  const f = await setup(t);
  for (const name of ["app-server", "accounts"]) {
    const temporary = join(f.home, name, "fixture/tmp/arg0/codex-session");
    await mkdir(temporary, {recursive:true});
    await symlink(join(f.home, "provider-credentials/private"), join(temporary, "apply_patch"));
    await writeFile(join(f.home, name, "fixture/tmp/keep.json"), "persistent-neighbor");
  }
  const status = await f.updater.install("0.153.5", f.hooks);
  for (const name of ["app-server", "accounts"]) {
    const saved = join(f.home, "runtime-updates/generations", status.recoveryId!, name, "fixture/tmp");
    assert.deepEqual(await readdir(saved), ["keep.json"]);
    assert.equal(await readFile(join(saved,"keep.json"),"utf8"), "persistent-neighbor");
    assert.deepEqual(await readdir(join(f.home,name,"fixture/tmp/arg0/codex-session")), ["apply_patch"]);
  }
  await f.updater.rollback(status.recoveryId!, f.hooks);
  assert.equal(await readFile(join(f.home,"app-server/fixture/history.json"),"utf8"), "old-thread-and-session");
});
test("snapshot still rejects a symlink at the arg0 directory boundary", async (t) => {
  const f = await setup(t);
  await mkdir(join(f.home,"app-server/fixture/tmp"));
  await symlink(join(f.home,"provider-credentials"),join(f.home,"app-server/fixture/tmp/arg0"), "dir");
  await assert.rejects(f.updater.install("0.153.5", f.hooks), /symbolic link/);
});
test("new snapshot revision retries a legacy activation failure once, but respects rollback", async (t) => {
  for (const rollback of [false,true]) {
    const f=await setup(t);
    await mkdir(join(f.home,"runtime-updates"),{recursive:true});
    await writeFile(join(f.home,"runtime-updates/active.json"),JSON.stringify({
      active:{version:"0.153.4",generation:null},previous:null,recoveryId:null,
      automatic:true,latestVersion:null,checkedAt:null,checks:[],failedAutomaticVersion:"0.153.5",
      ...(rollback?{message:"Restored App Server 0.153.4 and its saved session state."}:{})
    }));
    let attempts=0;
    const updater=new CoreUpdater(f.home,{...f.options,initialDelayMs:1,intervalMs:10,
      archive:async()=>{attempts++;throw Error("controlled");}});
    updater.start(f.hooks);
    await new Promise(r=>setTimeout(r,150));await updater.dispose();
    assert.equal(attempts,rollback?0:1);
  }
});
test("snapshot refuses external symlinks; recovery refuses a corrupt backup", async (t) => {
  const f = await setup(t);
  await symlink(
    join(f.home, "provider-credentials/private"),
    join(f.home, "app-server/fixture/link"),
  );
  await assert.rejects(f.updater.install("0.153.5", f.hooks), /symbolic link/);
  await rm(join(f.home, "app-server/fixture/link"));
  const status = await f.updater.install("0.153.5", f.hooks);
  await writeFile(
    join(
      f.home,
      "runtime-updates/generations",
      status.recoveryId!,
      "app-server/fixture/history.json",
    ),
    "corrupt",
  );
  await assert.rejects(
    f.updater.rollback(status.recoveryId!, f.hooks),
    /Recovery copy changed/,
  );
  assert.equal(f.updater.snapshot().currentVersion, "0.153.5");
});
test("rollback journal survives a SQLite restore failure and replays on next startup", async (t) => {
  const f = await setup(t);
  const status = await f.updater.install("0.153.5", f.hooks);
  f.mutate();
  await assert.rejects(
    f.updater.rollback(status.recoveryId!, {
      ...f.hooks,
      restore: () => {
        throw Error("SQLite interrupted");
      },
    }),
    /SQLite interrupted/,
  );
  const reopened = new CoreUpdater(f.home, f.options);
  t.after(() => reopened.dispose());
  reopened.recoverState(f.hooks.restore);
  assert.equal(reopened.snapshot().currentVersion, "0.153.4");
  assert.equal(f.state().session, "original");
  assert.equal(
    Object.hasOwn(
      JSON.parse(
        await readFile(join(f.home, "runtime-updates/active.json"), "utf8"),
      ),
      "restoreState",
    ),
    false,
  );
});
test("failed release checks keep last successful observation and runtime unchanged", async (t) => {
  const f = await setup(t);
  await f.updater.check();
  const before = f.updater.snapshot();
  const other = new CoreUpdater(f.home, {
    ...f.options,
    fetch: (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch,
  });
  t.after(() => other.dispose());
  const result = await other.check();
  assert.equal(result.latestVersion, before.latestVersion);
  assert.equal(result.checkedAt, before.checkedAt);
  assert.match(result.message, /HTTP 429/);
});
