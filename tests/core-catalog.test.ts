import test from "node:test";
import assert from "node:assert/strict";
import { CoreCatalogReader } from "../src/engine/core-catalog";
import { AppServerError } from "../src/engine/app-server-transport";
import type { prepareAxiomProcess } from "../src/engine/axiom-process";
const identity = {
  providerId: "owned",
  workspaceId: "workspace",
  remote: false,
};
const prepared = async (): Promise<
  Awaited<ReturnType<typeof prepareAxiomProcess>>
> => ({
  executable: "fixture",
  args: [],
  cwd: "/synora-owned/workspace",
  env: {},
  models: [],
});
const app = (id: string) => ({
  id,
  name: id,
  description: null,
  logoUrl: null,
  logoUrlDark: null,
  iconAssets: null,
  iconDarkAssets: null,
  distributionChannel: null,
  branding: null,
  appMetadata: null,
  labels: null,
  installUrl: null,
  isAccessible: true,
  isEnabled: true,
  pluginDisplayNames: [],
});
function fixture(mode = "ok") {
  const calls: { method: string; params: any }[] = [],
    rejected: any[] = [];
  let closes = 0,
    rejectHeld: ((e: Error) => void) | undefined;
  const reader = new CoreCatalogReader((options) => ({
    async request(method, params, timeout) {
      calls.push({ method, params });
      assert.ok(timeout! > 0 && timeout! <= 30000);
      if (method === "initialize") {
        options.onRequest({
          id: "unexpected-tool",
          method: "item/commandExecution/requestApproval",
        });
        return {} as any;
      }
      if (method === "account/read") {
        if (mode === "account-failed")
          throw new AppServerError(401, "PRIVATE ACCOUNT DETAIL");
        return { account: null, requiresOpenaiAuth: false } as any;
      }
      if (method === "plugin/list") {
        if (mode === "wait")
          return new Promise((_r, reject) => {
            rejectHeld = reject;
          });
        if (mode === "bad-plugin")
          return { marketplaces: "not-an-array" } as any;
        if (mode === "plugin-failed")
          throw new AppServerError(401, "SECRET-CONTENT-MUST-NOT-LEAK");
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        } as any;
      }
      if (method === "app/list") {
        if (mode === "missing-cursor") return { data: [app("one")] } as any;
        if (mode === "conflict") {
          const p = params as { cursor: string | null };
          return p.cursor ? { data: [{ ...app("one"), isAccessible: false }, app("two")], nextCursor: null } as any
            : { data: [app("one")], nextCursor: "next" } as any;
        }
        if (mode === "cursor-loop")
          return { data: [], nextCursor: "same" } as any;
        const p = params as { cursor: string | null };
        return p.cursor
          ? ({
              data: [app(mode === "duplicate" ? "one" : "two")],
              nextCursor: null,
            } as any)
          : ({ data: [app("one")], nextCursor: "next" } as any);
      }
      if (method === "app/installed") {
        const record = {
          id: "one",
          runtimeName: "Original one",
          enabled: true,
          callable: false,
        };
        return {
          apps: mode === "duplicate-installed" ? [record, record] : [record],
        } as any;
      }
      throw Error(`Unexpected RPC: ${method}`);
    },
    notify(method) {
      assert.equal(method, "initialized");
    },
    respond(id, data) {
      rejected.push({ id, data });
    },
    async close() {
      closes++;
      rejectHeld?.(Error("Closed owned connection"));
      if (mode === "cleanup-failed") throw Error("Cannot close");
    },
  }));
  return { reader, calls, rejected, closes: () => closes };
}
test("Original catalog calls preserve pagination, identity, availability and reject tool/approval callbacks without inference", async () => {
  const f = fixture();
  const result = await f.reader.read(identity, prepared);
  assert.equal(result.busy, false);
  assert.equal(result.scope, "provider-configuration");
  assert.equal(result.accountMode, null);
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    result.apps?.data.map((a) => a.id),
    ["one", "two"],
  );
  assert.equal(result.installedApps?.apps[0].callable, false);
  assert.deepEqual(result.errors, []);
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.calls.find((c) => c.method === "plugin/list")?.params, {
    cwds: ["/synora-owned/workspace"],
    marketplaceKinds: ["local"],
    forceRefetch: false,
  });
  assert.equal(f.rejected[0].id, "unexpected-tool");
  assert.equal(f.rejected[0].data.error.code, -32601);
  assert.ok(
    f.calls.every(
      (c) => !/turn\/|thread\/|install$|config\/.*write/.test(c.method),
    ),
  );
  const copy = f.reader.snapshot()!;
  copy.apps!.data.length = 0;
  assert.equal(f.reader.snapshot()!.apps?.data.length, 2);
  const remote = await f.reader.read({ ...identity, remote: true }, prepared);
  assert.notEqual(remote.id, result.id);
  assert.equal(
    f.calls.filter((c) => c.method === "plugin/list")[1].params
      .marketplaceKinds,
    undefined,
  );
});
test("Account read failure does not hide independent plugin/app catalogs; duplicate installed IDs stay unavailable", async () => {
  const f = fixture("account-failed");
  const s = await f.reader.read(identity, prepared);
  assert.equal(s.accountMode, undefined);
  assert.equal(s.errors[0].method, "account/read");
  assert.ok(s.plugins);
  assert.equal(s.apps?.data.length, 2);
  assert.equal(JSON.stringify(s).includes("PRIVATE ACCOUNT DETAIL"), false);
  const d = await fixture("duplicate-installed").reader.read(
    identity,
    prepared,
  );
  assert.equal(d.installedApps, null);
  assert.equal(d.errors[0].code, "CATALOG_DUPLICATE_INSTALLED_APP");
});
test("Catalog partial failures, malformed schema, duplicate identities and cursor loops are explicit, not empty success", async () => {
  for (const mode of [
    "bad-plugin",
    "plugin-failed",
    "cursor-loop",
  ]) {
    const f = fixture(mode);
    const s = await f.reader.read(identity, prepared);
    assert.equal(s.errors.length, 1);
    assert.equal(s.busy, false);
    assert.equal(f.closes(), 1);
    assert.equal(JSON.stringify(s).includes("SECRET-CONTENT"), false);
    if (mode.includes("plugin")) {
      assert.equal(s.plugins, null);
      assert.equal(s.apps?.data.length, 2);
    } else {
      assert.equal(s.apps, null);
      assert.ok(s.plugins);
    }
    assert.ok(s.installedApps);
  }
});
test("Identical connector page overlaps collapse without replacing metadata or duplicating actions", async () => {
  const f = fixture("duplicate");
  const s = await f.reader.read(identity, prepared);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.apps?.data, [app("one")]);
  assert.equal(s.identicalDuplicates?.apps, 1);
  assert.deepEqual(s.identityConflicts, []);
  assert.equal(f.calls.filter(c => c.method === "app/list").length, 2);
});
test("Conflicting connector identity blocks just that group, not independent records or installed runtime", async () => {
  const f = fixture("conflict");
  const s = await f.reader.read(identity, prepared);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.apps?.data, [app("two")]);
  assert.deepEqual(s.identityConflicts, [{ kind: "app", id: "one", occurrences: 2 }]);
  assert.equal(s.installedApps?.apps[0].id, "one");
  assert.equal(s.installedApps?.apps[0].callable, false);
  assert.equal(s.busy, false);
});
test("Schema-allowed missing terminal cursor ends after one request, never restarts page one", async () => {
  const f = fixture("missing-cursor");
  const s = await f.reader.read(identity, prepared);
  assert.deepEqual(s.apps?.data, [app("one")]);
  assert.deepEqual(s.errors, []);
  assert.equal(f.calls.filter(c => c.method === "app/list").length, 1);
});
test("Catalog cancel is exact-ID, holds the single-operation lock, closes owned work and never publishes successful completion", async () => {
  const f = fixture("wait");
  const pending = f.reader.read(identity, prepared);
  for (
    let i = 0;
    i < 100 && !f.calls.some((c) => c.method === "plugin/list");
    i++
  )
    await new Promise((r) => setTimeout(r, 2));
  const id = f.reader.snapshot()!.id;
  assert.throws(() => f.reader.read(identity, prepared), /existing catalog/);
  await assert.rejects(f.reader.cancel("wrong-id"), /identity/);
  const s = await f.reader.cancel(id);
  await pending;
  assert.equal(s?.cancelled, true);
  assert.equal(s?.busy, false);
  assert.equal(s?.plugins, null);
  assert.equal(s?.apps, null);
  assert.equal(
    f.calls.some((c) => c.method === "app/list"),
    false,
  );
});
test("Cancellation during preparation cleans prepared resources without spawning; cleanup failure is sticky", async () => {
  let release!: (v: Awaited<ReturnType<typeof prepareAxiomProcess>>) => void,
    cleanups = 0;
  const f = fixture();
  const pending = f.reader.read(
    identity,
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const cancelled = f.reader.cancel(f.reader.snapshot()!.id);
  assert.equal(f.reader.busy, true);
  release({
    ...(await prepared()),
    cleanup: async () => {
      cleanups++;
    },
  });
  const result = await cancelled;
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(cleanups, 1);
  assert.equal(result?.busy, false);
  const failed = fixture("cleanup-failed");
  const s = await failed.reader.read(identity, prepared);
  assert.equal(s.cleanupFailed, true);
  assert.equal(failed.reader.busy, true);
  assert.throws(() => failed.reader.read(identity, prepared), /cleanup/);
});
test("Catalog preparation consumes the deadline; no late RPC or success is emitted", async () => {
  let calls = 0,
    closed = 0;
  const reader = new CoreCatalogReader(
    () => ({
      request: async () => {
        calls++;
        return {} as any;
      },
      notify: () => {},
      respond: () => {},
      close: async () => {
        closed++;
      },
    }),
    1,
  );
  const s = await reader.read(identity, async () => {
    await new Promise((r) => setTimeout(r, 8));
    return prepared();
  });
  assert.equal(calls, 0);
  assert.equal(closed, 1);
  assert.equal(s.busy, false);
  assert.equal(s.errors[0].code, "CATALOG_DEADLINE");
  assert.equal(s.plugins, null);
});
