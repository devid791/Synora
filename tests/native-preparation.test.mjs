import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { patchWindowsPty } from "../scripts/patch-windows-pty.mjs";

test("Pinned Windows PTY patch is idempotent and rejects unreviewed source changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synora-native-patch-"));
  const dependency = path.join(root, "node_modules/node-pty");
  await fs.mkdir(path.join(dependency, "lib"), { recursive: true });
  const file = path.join(dependency, "lib/windowsPtyAgent.js");
  try {
    await fs.copyFile(
      new URL(
        "../node_modules/node-pty/lib/windowsPtyAgent.js",
        import.meta.url,
      ),
      file,
    );
    await fs.writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ version: "1.1.0" }),
    );
    await patchWindowsPty(root);
    const patched = await fs.readFile(file, "utf8");
    assert.ok(
      patched.startsWith("// Synora node-pty 1.1.0 Windows lifecycle patch v1"),
    );
    assert.match(patched, /Copyright .*Microsoft Corporation/);
    await patchWindowsPty(root);
    assert.equal(await fs.readFile(file, "utf8"), patched);
    await fs.appendFile(file, "\n// unexpected change\n");
    await assert.rejects(patchWindowsPty(root), /unexpected changes/);
    await fs.writeFile(file, patched);
    await fs.writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({ version: "2.0.0" }),
    );
    await assert.rejects(patchWindowsPty(root), /requires node-pty 1.1.0/);
    assert.equal(await fs.readFile(file, "utf8"), patched);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
