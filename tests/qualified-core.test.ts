import test from "node:test";
import assert from "node:assert/strict";
import { qualifiedCore } from "../src/engine/qualified-core";
test("Public Mac Core 0.154 metadata retains its historical evidence pin and platform boundary", () => {
  const core = qualifiedCore("0.154.0", "darwin-arm64");
  // The private raw report is deliberately not exported. This checks the
  // retained identity, not fresh execution or public reproduction of that QA.
  assert.equal(
    core.qualification.evidenceSha256,
    "3c08ee65a5ee9ab644becb605c65ef05c4dbb7285ce5cfb90a49edc3f33e5fb6",
  );
  assert.equal(
    core.package.files["bin/codex"][1],
    "4f85982624b3898c8991cb80c0981b2aa71070e3537046c9a95950318a95afcc",
  );
  for (const platform of ["linux-x64", "win32-x64"])
    assert.throws(() => qualifiedCore("0.154.0", platform), /qualified/);
  assert.throws(() => qualifiedCore("0.155.0", "darwin-arm64"), /qualified/);
});
