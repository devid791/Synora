import test from "node:test";
import assert from "node:assert/strict";
import {
  accountProvider,
  providerPreset,
} from "../src/shared/provider-onboarding";
import {
  providerDefinitions,
  type ProviderType,
} from "../src/shared/provider-registry";
import { configSchema } from "../src/shared/contracts";
test("Every mounted directory entry produces a valid preset, except endpoints requiring user input", () => {
  for (const type of Object.keys(providerDefinitions) as ProviderType[]) {
    const preset = providerPreset(type, []);
    if (type === "axiom" || type === "compatible")
      preset.endpoint = "http://127.0.0.1:8015/codex/v1";
    assert.ok(
      configSchema.safeParse(preset).success,
      JSON.stringify(configSchema.safeParse(preset)),
    );
    assert.equal(preset.enabled, true);
    assert.equal(preset.tools.length, 0);
  }
});
test("Authenticated Core links exactly one provider without overwriting disabled configuration or exposing credentials", () => {
  const p = accountProvider({ type: "chatgpt" }, [])!;
  assert.equal(p.providerType, "openai");
  assert.equal(p.auth, "core-account");
  assert.equal(accountProvider({ type: "chatgpt" }, [p]), null);
  assert.equal(
    accountProvider({ type: "apiKey" }, [{ ...p, enabled: false }]),
    null,
  );
  assert.equal(accountProvider(null, []), null);
  assert.equal(accountProvider({ type: "amazonBedrock" }, []), null);
  const collision = { ...providerPreset("axiom", []), id: p.id };
  assert.notEqual(
    accountProvider({ type: "chatgpt" }, [collision])!.id,
    collision.id,
  );
});
