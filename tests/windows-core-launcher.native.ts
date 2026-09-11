// Explicit Windows CPU-only gate, outside the portable unit-suite glob.
// No sandbox setup, model inference, firewall or account mutation.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlledCoreLauncher } from "./fixtures/controlled-core-launcher";
import { sha256File } from "../src/engine/core-runtime";
if (process.platform !== "win32")
  throw Error("This native gate requires Windows");
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "synora-launcher-"));
const make = async (
  name: string,
  binary = process.execPath,
  endpoint?: string,
) => {
  const path = join(directory, name);
  await mkdir(path);
  return controlledCoreLauncher(path, binary, endpoint);
};

test("native launcher preserves Unicode paths, empty/quoted/backslash argv, cwd, environment and stdio", async () => {
  const wrapper = await make("space é ø");
  const args = [
    "",
    "a b",
    'a"b',
    "C:\\end\\",
    'x\\\\"y',
    "%PATH%",
    "$()",
    "éΩ",
    "tab\there",
  ];
  const script =
    "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>data+=b);process.stdin.on('end',()=>{console.error('NATIVE_STDERR');console.log(JSON.stringify({args:process.argv.slice(1),data,cwd:process.cwd(),marker:process.env.SYNORA_LAUNCHER_TEST_MARKER}));});";
  const child = spawn(wrapper, ["-e", script, "--", ...args], {
    cwd: directory,
    env: { ...process.env, SYNORA_LAUNCHER_TEST_MARKER: "owned-only" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (b) => (stdout += b));
  child.stderr.setEncoding("utf8").on("data", (b) => (stderr += b));
  child.stdin.end("SYNORA_PIPE_é\n");
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const exit = await new Promise<number | null>((accept, reject) => {
      child.on("error", reject);
      child.on("close", accept);
    });
    assert.equal(exit, 0);
    assert.match(stderr, /NATIVE_STDERR/);
    assert.deepEqual(JSON.parse(stdout), {
      args,
      data: "SYNORA_PIPE_é\n",
      cwd: directory,
      marker: "owned-only",
    });
  } finally {
    clearTimeout(timer);
  }
});

test("native launcher returns original child failure status", async () => {
  const wrapper = await make("exit-code");
  await assert.rejects(
    run(
      wrapper,
      ["-e", "process.stderr.write('EXPECTED_ERROR');process.exit(7)"],
      { timeout: 10000 },
    ),
    (e: any) => e.code === 7 && e.stderr === "EXPECTED_ERROR",
  );
});

test("native launcher does not modify original Core and --version remains exact", async () => {
  const core = process.env.SYNORA_QA_ORIGINAL_CORE;
  assert.ok(core);
  const sha =
    "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b";
  assert.equal(await sha256File(core), sha);
  const wrapper = await make(
    "original-core",
    core,
    "http://127.0.0.1:49151/v1",
  );
  const response = await run(wrapper, ["--version"], { timeout: 10000 });
  assert.equal(response.stdout.trim(), "codex-cli 0.153.4");
  assert.equal(await sha256File(core), sha);
});

test("native launcher fails closed for a non-loopback endpoint even if its sidecar is corrupted", async () => {
  const wrapper = await make("invalid-route");
  await writeFile(
    `${wrapper}.ini`,
    Buffer.from(
      `\ufeff[launcher]\r\nexecutable=${process.execPath}\r\nendpoint=https://api.openai.com/v1\r\n`,
      "utf16le",
    ),
  );
  await assert.rejects(
    run(wrapper, ["--version"], { timeout: 10000 }),
    (e: any) => e.code === 126 && e.stderr.includes("loopback"),
  );
});
