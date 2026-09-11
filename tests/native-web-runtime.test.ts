import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unpackNativeWeb } from "../src/engine/native-web-runtime";
test("packaged native helper survives decompression/reuse without changing its signed bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "synora-native-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resources = join(root, "resources"),
    state = join(root, "state");
  await mkdir(resources);
  const bytes = Buffer.from("fixture binary: no execution"),
    digest = createHash("sha256").update(bytes).digest("hex");
  const name =
    process.platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp";
  const receipt = {
    platform: process.platform,
    arch: process.arch,
    sha256: digest,
  };
  await writeFile(
    join(resources, "web-mcp-manifest.json"),
    JSON.stringify(receipt),
  );
  await writeFile(join(resources, name + ".gz"), gzipSync(bytes));
  const paths = await Promise.all([
    unpackNativeWeb(resources, state),
    unpackNativeWeb(resources, state),
  ]);
  assert.equal(paths[0], paths[1]);
  assert.deepEqual(await readFile(paths[0]), bytes);
  assert.equal(await unpackNativeWeb(resources, state), paths[0]);
  await writeFile(paths[0], "tampered");
  await assert.rejects(unpackNativeWeb(resources, state), /integrity mismatch/);
  assert.equal(await readFile(paths[0], "utf8"), "tampered");
  await writeFile(
    join(resources, name + ".gz"),
    gzipSync(Buffer.from("wrong")),
  );
  await assert.rejects(
    unpackNativeWeb(resources, join(root, "other-state")),
    /archive integrity mismatch/,
  );
  await writeFile(
    join(resources, "web-mcp-manifest.json"),
    JSON.stringify({ ...receipt, arch: "invalid" }),
  );
  await assert.rejects(unpackNativeWeb(resources, state), /wrong platform/);
});
