import test from "node:test";
import assert from "node:assert/strict";
import { qualifiedCore, qualifiedCoreUpdates } from "../src/engine/qualified-core";
import { corePackage, legacyCorePackage, BUNDLED_CORE_VERSION } from "../src/engine/core-runtime";
import { PROTOCOL_VERSION } from "../src/shared/contracts";
test("Historical Mac Core 0.154 evidence pin is retained independently of the new bootstrap", () => {
  const core = qualifiedCoreUpdates.find(c => c.package.version === "0.154.0" && c.package.target === "aarch64-apple-darwin")!;
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
  assert.throws(() => qualifiedCore("0.155.0", "darwin-arm64"), /qualified/);
});
test("New bootstrap and retained rollback have exact distinct pins on every supported platform", () => {
  assert.equal(BUNDLED_CORE_VERSION, "0.154.0");
  assert.equal(PROTOCOL_VERSION, "0.153.4");
  for (const key of ["linux-x64", "win32-x64", "darwin-arm64"]) {
    const current = corePackage(key), previous = legacyCorePackage(key);
    assert.equal(current.version, BUNDLED_CORE_VERSION);
    assert.equal(previous.version, "0.153.4");
    assert.equal(current.target, previous.target);
    assert.notEqual(current.sha256, previous.sha256);
    assert.deepEqual(qualifiedCore(current.version, key).package, current);
    assert.deepEqual(qualifiedCore(previous.version, key).package, previous);
    assert.ok(Object.keys(current.files).length >= 5);
    assert.throws(() => qualifiedCore("0.155.0", key), /qualified/);
  }
  assert.throws(() => corePackage("linux-armv7"), /qualified/);
});
