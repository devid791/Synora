import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlledCoreLauncher } from "./fixtures/controlled-core-launcher";

test("controlled launcher rejects remote endpoint before constructing a process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "synora-launcher-negative-"));
  for (const endpoint of [
    "https://api.openai.com/v1",
    "http://example.invalid/v1",
    "http://127.0.0.1:99/v1?redirect=x",
    "http://127.0.0.1:99/v1\n",
  ])
    await assert.rejects(
      controlledCoreLauncher(directory, process.execPath, endpoint),
      /loopback/,
    );
});

test("controlled launcher preserves the original POSIX quoting contract", async () => {
  // Explicitly inspect POSIX file generation on any host. Native execution is
  // a separate required Windows gate, never claimed from this assertion.
  const directory = await mkdtemp(join(tmpdir(), "synora-launcher-posix-"));
  const wrapper = await controlledCoreLauncher(
    directory,
    "/test/it's core",
    "http://127.0.0.1:42/v1",
    "linux",
  );
  const text = await readFile(wrapper, "utf8");
  assert.ok(text.includes("'/test/it'\\''s core'"));
  assert.ok(text.includes('"$@"'));
  assert.ok(text.includes('openai_base_url="http://127.0.0.1:42/v1"'));
});
