import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { windowsCoreHome } from "../src/engine/windows-core-home";
const fresh = () => mkdtempSync(join(tmpdir(), "synora-windows-home-"));
const populated = (base: string, relative: string) => {
  const path = join(base, relative);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "owned-marker.txt"), "PRESERVE");
  return path;
};

test("one stable app-owned Windows Core home without OS provisioning", () => {
  const root = fresh();
  const first = windowsCoreHome(root);
  assert.equal(first.error, undefined);
  assert.equal(first.path, join(root, "app-server", "windows-core"));
  assert.deepEqual(readdirSync(first.path), []);
  assert.deepEqual(windowsCoreHome(root), first);
});
test("sole legacy home is adopted in place, preserving credentials and history bytes", () => {
  for (const relative of ["app-server/native-axiom", "accounts/openai"]) {
    const root = fresh();
    const path = populated(root, relative);
    mkdirSync(join(path, ".sandbox-secrets"));
    const fixture = join(path, ".sandbox-secrets", "fixture-only.txt");
    writeFileSync(fixture, "NOT-A-REAL-CREDENTIAL");
    const before = readFileSync(fixture);
    assert.deepEqual(windowsCoreHome(root), { path });
    assert.deepEqual(readFileSync(fixture), before);
    assert.equal(
      readFileSync(join(path, "owned-marker.txt"), "utf8"),
      "PRESERVE",
    );
    assert.deepEqual(windowsCoreHome(root), { path });
  }
});
test("multiple populated legacy homes fail closed without merging or resetting", () => {
  const root = fresh();
  const a = populated(root, "app-server/axiom"),
    b = populated(root, "accounts/openai");
  assert.match(windowsCoreHome(root).error!, /reviewed migration/);
  for (const p of [a, b])
    assert.equal(readFileSync(join(p, "owned-marker.txt"), "utf8"), "PRESERVE");
  assert.deepEqual(readdirSync(join(root, "app-server")), ["axiom"]);
});
test("malformed, escaping, linked and missing bindings are not silently replaced", () => {
  for (const relative of [
    "../../outside",
    "app-server/.sandbox-secrets",
    "app-server/absent",
    "app-server/one/two",
  ]) {
    const root = fresh();
    mkdirSync(join(root, "app-server"));
    const file = join(root, "app-server", ".windows-home.json");
    const value = JSON.stringify({
      schema: "synora.windows-core-home.v1",
      relative,
    });
    writeFileSync(file, value);
    assert.ok(windowsCoreHome(root).error);
    assert.equal(readFileSync(file, "utf8"), value);
  }
  const root = fresh(),
    outside = fresh();
  mkdirSync(join(root, "app-server"));
  symlinkSync(
    outside,
    join(root, "app-server", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.ok(windowsCoreHome(root).error);
  assert.deepEqual(readdirSync(outside), []);
});
