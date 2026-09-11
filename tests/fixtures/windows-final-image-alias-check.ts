// Explicit Windows short-name regression; no TMP/TEMP changes or app/Core use.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageAttachments } from "../../src/main/image-attachments";

assert.equal(process.platform, "win32");
const mode = process.env.SYNORA_IMAGE_ALIAS_EXPECT;
assert.ok(
  mode === "reject" || mode === "pass",
  "Explicit baseline/fix mode required",
);
const output = process.env.SYNORA_IMAGE_ALIAS_RECEIPT;
assert.ok(output, "Explicit new QA evidence path required");
const directory = await mkdtemp(
  join(tmpdir(), "synora-windows-final-image-alias-"),
);
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const receipt: Record<string, unknown> = {
  started: new Date().toISOString(),
  mode,
  directory,
  tempPath: tmpdir(),
  legacyParent: realpathSync(directory),
  nativeParent: realpathSync.native(directory),
  asyncParent: await realpath(directory),
  sourceSha256: digest(await readFile("src/main/image-attachments.ts")),
  helperSha256: digest(
    await readFile("tests/fixtures/windows-final-image-alias-check.ts"),
  ),
  inferenceRequests: 0,
  appOrCoreLaunches: 0,
  passed: false,
};
try {
  assert.match(
    tmpdir(),
    /AXIOM-~1/i,
    "Require the actual limited-session 8.3 temp alias",
  );
  assert.notEqual(receipt.legacyParent, receipt.nativeParent);
  assert.equal(receipt.nativeParent, receipt.asyncParent);
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = {
    name: "alias.png",
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
  };
  const cache = new ImageAttachments(join(directory, "images"));
  if (mode === "reject") {
    await assert.rejects(
      cache.add("owned", upload),
      /^Error: Image storage must not be linked$/,
    );
    receipt.reproducedError = "Image storage must not be linked";
  } else {
    const image = await cache.add("owned", upload);
    const restored = await cache.read("owned", image);
    assert.equal(restored.dataUrl, upload.dataUrl);
    assert.equal(restored.path, await realpath(restored.path));
    assert.equal(
      new ImageAttachments(join(realpathSync.native(directory), "images")).path(
        "owned",
        image,
      ),
      restored.path,
    );
    await cache.remove("owned", image);
    await assert.rejects(readFile(restored.path), /ENOENT/);
    receipt.roundTripAndRemoval = true;
  }
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  receipt.finished = new Date().toISOString();
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify(receipt));
}
