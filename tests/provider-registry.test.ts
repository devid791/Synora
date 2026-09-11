import test from "node:test";
import assert from "node:assert/strict";
import {
  mountedProviderTypes,
  mountedProviderType,
  providerDefinitions,
  providerDefinition,
  providerUsesCoreModel,
  providerRuntimeLabel,
} from "../src/shared/provider-registry";
import { configSchema } from "../src/shared/contracts";
import { compatibleFixtureSettings } from "./fixtures/compatible-settings";

test("mounted adapters share engine/telemetry identity; custom capability contract is explicit", () => {
  for (const type of mountedProviderTypes) {
    assert.equal(providerUsesCoreModel(type), type !== "axiom");
    assert.ok(providerRuntimeLabel(type));
  }
  for (const type of [undefined, "", "constructor", "unknown"])
    assert.equal(providerUsesCoreModel(type), false);
  const base = {
    id: "custom",
    name: "Controlled",
    kind: "provider",
    providerType: "compatible",
    endpoint: "http://127.0.0.1:8015/v1",
    enabled: true,
    auth: "none",
    tools: [],
    compatible: compatibleFixtureSettings,
  };
  assert.equal(configSchema.safeParse(base).success, true);
  assert.equal(
    configSchema.safeParse({ ...base, auth: "api-key" }).success,
    true,
  );
  for (const override of [
    { compatible: undefined },
    { auth: "oauth" },
    { tools: ["bash"] },
    { providerType: "axiom" },
    { kind: "mcp" },
  ])
    assert.equal(
      configSchema.safeParse({ ...base, ...override }).success,
      false,
    );
  assert.equal(
    configSchema.safeParse({
      ...base,
      providerType: "mistral",
      auth: "api-key",
      compatible: undefined,
    }).success,
    true,
  );
  assert.equal(
    configSchema.safeParse({
      ...base,
      providerType: "mistral",
      compatible: undefined,
    }).success,
    false,
  );
});

test("provider registry covers required families without advertising unfinished executors", () => {
  assert.deepEqual(Object.keys(providerDefinitions), [
    "axiom",
    "openai",
    "xai",
    "anthropic",
    "gemini",
    "deepseek",
    "mistral",
    "openrouter",
    "compatible",
  ]);
  assert.deepEqual(
    Object.entries(providerDefinitions)
      .filter(([, v]) => v.mounted)
      .map(([k]) => k),
    [...mountedProviderTypes],
  );
  assert.equal(providerDefinition(undefined), providerDefinitions.axiom);
  for (const type of ["", "__proto__", "constructor", "invented"])
    assert.throws(() => mountedProviderType(type), /Unknown provider/);
  for (const [type, definition] of Object.entries(providerDefinitions)) {
    if (definition.mounted) assert.equal(mountedProviderType(type), type);
    else assert.throws(() => mountedProviderType(type), /not mounted/);
  }
  assert.equal(providerDefinitions.openrouter.browser, "pkce-key-exchange");
  assert.equal(providerDefinitions.gemini.browser, "own-client-pkce");
  assert.equal(providerDefinitions.anthropic.browser, "not-qualified");
});
test("persisted provider configuration cannot silently reinterpret an unknown adapter as Axiom", () => {
  const value = {
    id: "legacy",
    name: "Legacy Axiom",
    kind: "provider",
    endpoint: "http://127.0.0.1:8015/codex/v1",
    auth: "none",
    tools: [],
    enabled: true,
  };
  assert.equal(configSchema.parse(value).providerType, undefined);
  for (const providerType of [
    "unknown",
    "openrouter",
    "anthropic",
    "__proto__",
  ])
    assert.equal(
      configSchema.safeParse({ ...value, providerType }).success,
      false,
    );
});
