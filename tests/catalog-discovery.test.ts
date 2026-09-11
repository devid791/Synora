import test from "node:test";
import assert from "node:assert/strict";
import { supplementPublicCatalog } from "../src/shared/core-catalog";
import type { PluginListResponse } from "../src/protocol/codex-0.153.4/v2/PluginListResponse";
const market = (name: string, names: string[]) => ({
  name,
  path: `/public/${name}`,
  interface: null,
  plugins: names.map((p) => ({
    id: `${p}@${name}`,
    name: p,
    installed: false,
    enabled: false,
    interface: { logo: `/public/${p}/logo.svg` },
  })),
});
const catalog = (...marketplaces: ReturnType<typeof market>[]) =>
  ({
    marketplaces,
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  }) as unknown as PluginListResponse;
test("Public catalog reveals unconnected Gmail without duplicating eligible wire identities", () => {
  const eligible = catalog(market("openai-api-curated", ["figma"]));
  const full = catalog(
    market("openai-curated", ["gmail", "figma", "google-calendar"]),
  );
  const saved = JSON.stringify([eligible, full]);
  const result = supplementPublicCatalog(eligible, full);
  assert.deepEqual(
    result.plugins.marketplaces.flatMap((m) => m.plugins.map((p) => p.id)),
    [
      "figma@openai-api-curated",
      "gmail@openai-curated",
      "google-calendar@openai-curated",
    ],
  );
  assert.deepEqual(result.discoveryOnlyPluginIds, [
    "gmail@openai-curated",
    "google-calendar@openai-curated",
  ]);
  assert.equal(
    result.plugins.marketplaces[1].plugins[0].interface?.logo,
    "/public/gmail/logo.svg",
  );
  assert.equal(result.plugins.marketplaces[1].plugins[0].enabled, false);
  assert.equal(JSON.stringify([eligible, full]), saved);
});
test("Connected identity, installed state and unrelated marketplaces are never replaced", () => {
  const eligible = catalog(
    market("openai-curated", ["gmail"]),
    market("personal", ["gmail"]),
  );
  eligible.marketplaces[0].plugins[0].installed = true;
  eligible.marketplaces[0].plugins[0].enabled = true;
  const full = catalog(
    market("openai-curated", ["gmail", "gmail"]),
    market("untrusted", ["invented"]),
  );
  const result = supplementPublicCatalog(eligible, full);
  assert.deepEqual(result.plugins, eligible);
  assert.deepEqual(result.discoveryOnlyPluginIds, []);
});
