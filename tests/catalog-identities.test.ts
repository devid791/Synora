import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogIdentityIndex, normalizePluginIdentities } from "../src/engine/catalog-identities";
import { CoreCatalogReader } from "../src/engine/core-catalog";
import type { PluginSummary } from "../src/protocol/codex-0.153.4/v2/PluginSummary";
import type { PluginListResponse } from "../src/protocol/codex-0.153.4/v2/PluginListResponse";
const plugin = (id = "proof@market"): PluginSummary => ({ id, name: id, remotePluginId: "remote-one", version: "1",
  localVersion: null, shareContext: null, source: { type: "remote" }, installed: false, installedAt: null,
  enabled: false, installPolicy: "AVAILABLE", installPolicySource: null, mustShowInstallationInterstitial: null,
  authPolicy: "ON_INSTALL", availability: "AVAILABLE", disabledReason: null, eligiblePlanTypes: null, interface: null, keywords: [] });
const market = (plugins: PluginSummary[], name = "market", path: string | null = null) => ({ name, path, interface: null, plugins });
const catalog = (...marketplaces: PluginListResponse["marketplaces"]): PluginListResponse => ({ marketplaces, marketplaceLoadErrors: [], featuredPluginIds: [] });

test("Exact plugin copies collapse in the same or repeated marketplace without mutating original data", () => {
  const p = plugin(), input = catalog(market([p, structuredClone(p), plugin("healthy")]), market([structuredClone(p)]));
  const before = structuredClone(input), out = normalizePluginIdentities(input);
  assert.equal(out.identicalDuplicates, 2);
  assert.deepEqual(out.conflicts, []);
  assert.deepEqual(out.plugins.marketplaces.flatMap(m => m.plugins), [p, plugin("healthy")]);
  assert.deepEqual(input, before);
});
for (const [field, value] of Object.entries({ remotePluginId: "remote-two", version: "2", source: { type: "local", path: "/other" },
  authPolicy: "ON_USE", enabled: true, installed: true, keywords: ["other"], futureCapability: { grant: true }, interface: { displayName: "Other" } })) {
  test(`Plugin conflict in ${field} is quarantined; later identical copy cannot clear it`, () => {
    const p = plugin(), input = catalog(market([p, { ...p, [field]: value }, structuredClone(p), plugin("healthy")]));
    const out = normalizePluginIdentities(input);
    assert.deepEqual(out.plugins.marketplaces[0].plugins, [plugin("healthy")]);
    assert.deepEqual(out.conflicts, [{ kind: "plugin", marketplace: "market", id: p.id, occurrences: 3 }]);
  });
}
test("Same marketplace name with different paths conflicts; different names and NUL tuples remain distinct", () => {
  const p = plugin();
  assert.equal(normalizePluginIdentities(catalog(market([p], "market", "/a"), market([p], "market", "/b"))).conflicts.length, 1);
  const distinct = normalizePluginIdentities(catalog(market([p], "one"), market([p], "two"),
    market([plugin("b\0c")], "a"), market([plugin("c")], "a\0b")));
  assert.equal(distinct.plugins.marketplaces.flatMap(m => m.plugins).length, 4);
  assert.deepEqual(distinct.conflicts, []);
});
test("Equality preserves array order, null/missing, unknown fields and original availability", () => {
  for (const [a,b] of [[{ id: "x", extra: null }, { id: "x" }],
    [{ id: "x", order: [1,2] }, { id: "x", order: [2,1] }],
    [{ id: "x", isAccessible: true }, { id: "x", isAccessible: false }]]) {
    const index = new CatalogIdentityIndex<object>();
    index.add("x", a); index.add("x", b); index.add("good", { id: "good", isAccessible: false });
    assert.deepEqual(index.result().values, [{ id: "good", isAccessible: false }]);
    assert.deepEqual(index.result().conflicts, [{ key: "x", occurrences: 2 }]);
  }
  const index = new CatalogIdentityIndex<object>();
  index.add("same", { id: "same", enabled: false }); index.add("same", { enabled: false, id: "same" });
  assert.equal(index.result().identicalDuplicates, 1); // JSON object key order is immaterial.
});
test("Reader publishes healthy plugins and rejects conflicting action targets before any RPC", async () => {
  const calls: string[] = [];
  const p = plugin(), healthy = plugin("healthy");
  const reader = new CoreCatalogReader(() => ({
    request: async <T>(method: string) => {
      calls.push(method);
      const responses: Record<string, unknown> = { initialize: {}, "account/read": { account: null, requiresOpenaiAuth: false },
        "plugin/list": catalog(market([p, { ...p, remotePluginId: "remote-two" }, healthy, structuredClone(healthy)])),
        "app/list": { data: [], nextCursor: null }, "app/installed": { apps: [] } };
      assert.ok(Object.hasOwn(responses, method)); return structuredClone(responses[method]) as T;
    }, notify: () => {}, respond: () => {}, close: async () => {},
  }));
  const s = await reader.read({ providerId: "owned", workspaceId: "qa", remote: true }, async () => ({ executable: "fixture", args: [], cwd: "/owned", env: {}, models: [] }));
  assert.deepEqual(s.errors, []);
  assert.equal(s.identityConflicts?.length, 1);
  assert.equal(s.identicalDuplicates?.plugins, 1);
  assert.throws(() => reader.pluginTarget(s.id, "market", p.id), /ambiguous/);
  const target = reader.pluginTarget(s.id, "market", healthy.id);
  assert.equal(target.remotePluginId, healthy.remotePluginId);
  assert.equal(target.discoveryOnly, false);
  assert.deepEqual(calls, ["initialize", "account/read", "plugin/list", "app/list", "app/installed"]);
  assert.equal(s.busy, false);
});
for (const accountMarketplace of ["openai-curated", "openai-api-curated"])
test(`Public fallback preserves account conflicts and healthy precedence: ${accountMarketplace}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "synora-catalog-conflicts-"));
  await mkdir(join(root, ".tmp/plugins/.agents/plugins"), { recursive: true });
  await writeFile(join(root, ".tmp/plugins/.agents/plugins/marketplace.json"), "{}");
  const blocked = { ...plugin(`blocked@${accountMarketplace}`), name: "blocked" };
  const healthy = { ...plugin(`healthy@${accountMarketplace}`), name: "healthy" };
  const publicBlocked = { ...blocked, id: "blocked@openai-curated" }, publicHealthy = { ...healthy, id: "healthy@openai-curated" };
  const publicOnly = plugin("public-only");
  let pluginCalls = 0;
  const reader = new CoreCatalogReader(() => ({
    request: async <T>(method: string) => {
      if (method === "plugin/list") return (pluginCalls++ === 0
        ? catalog(market([blocked, { ...blocked, remotePluginId: "other" }, healthy], accountMarketplace),
          market([{ ...plugin("independent"), name: "blocked" }], "personal"))
        : catalog(market([publicBlocked, publicHealthy, { ...publicHealthy, enabled: true }, publicOnly], "openai-curated"),
          market([plugin("untrusted"), { ...plugin("untrusted"), version: "other" }], "untrusted"))) as T;
      return ({ initialize: {}, "account/read": { account: null, requiresOpenaiAuth: false },
        "app/list": { data: [], nextCursor: null }, "app/installed": { apps: [] } } as Record<string, unknown>)[method] as T;
    }, notify: () => {}, respond: () => {}, close: async () => {},
  }));
  try {
    const s = await reader.read({ providerId: "owned", workspaceId: "qa", remote: true }, async () => ({
      executable: "fixture", args: [], cwd: root, env: { CODEX_HOME: root }, models: [] }));
    assert.equal(pluginCalls, 2);
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.plugins?.marketplaces.flatMap(m => m.plugins).map(p => p.id).sort(), [healthy.id, "independent", publicOnly.id].sort());
    assert.deepEqual(s.identityConflicts, [{ kind: "plugin", marketplace: accountMarketplace, id: blocked.id, occurrences: 2 }]);
    assert.throws(() => reader.pluginTarget(s.id, accountMarketplace, blocked.id), /ambiguous/);
    assert.throws(() => reader.pluginTarget(s.id, "openai-curated", publicBlocked.id), /ambiguous/);
    assert.equal(reader.pluginTarget(s.id, accountMarketplace, healthy.id).discoveryOnly, false);
    assert.equal(reader.pluginTarget(s.id, "personal", "independent").discoveryOnly, false);
    assert.equal(reader.pluginTarget(s.id, "openai-curated", "public-only").discoveryOnly, true);
  } finally { await reader.dispose(); await rm(root, { recursive: true, force: true }); }
});
