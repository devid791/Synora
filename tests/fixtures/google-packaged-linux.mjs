// One bounded, CPU/software-rendered packaged OAuth case. No build/install.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "linux", "This runner qualifies Linux only");
const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    asar: { type: "string" },
    commit: { type: "string" },
  },
});
assert.ok(
  values.executable && values.asar && values.commit,
  "--executable PATH --asar SHA256 --commit FROZEN_COMMIT required",
);
assert.match(values.asar, /^[a-f0-9]{64}$/);
assert.match(values.commit, /^[a-f0-9]{40}$/);
for (const key of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "LD_PRELOAD"])
  assert.ok(!process.env[key], `Refusing inherited ${key}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = resolve(values.executable);
const asar = join(dirname(executable), "resources/app.asar");
const hash = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const before = { executable: await hash(executable), asar: await hash(asar) };
assert.equal(before.asar, values.asar);
const parent = join(root, "out/live-evidence");
await mkdir(parent, { recursive: true });
const run = await mkdtemp(join(parent, "google-packaged-linux-"));
console.log(`GOOGLE_PACKAGE_EVIDENCE=${run}`);
const started = new Date().toISOString();
const command = [
  "--user",
  "--map-current-user",
  "--keep-caps",
  "--net",
  "--",
  "sh",
  "-c",
  'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all xvfb-run -a -s "-screen 0 1800x1200x24 -extension GLX" "$1" node_modules/@playwright/test/cli.js test --config playwright.google-desktop.config.ts',
  "google-packaged-qa",
  process.execPath,
];
const output = createWriteStream(join(run, "runner.log"), {
  flags: "wx",
  mode: 0o600,
});
const child = spawn("unshare", command, {
  cwd: root,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    SYNORA_TEST_EXECUTABLE: executable,
    SYNORA_QA_EXPECT_ASAR: values.asar,
    SYNORA_QA_APP_COMMIT: values.commit,
    SYNORA_QA_GOOGLE_RUN_DIR: run,
  },
});
child.stdout.on("data", (data) => {
  output.write(data);
  process.stdout.write(data);
});
child.stderr.on("data", (data) => {
  output.write(data);
  process.stderr.write(data);
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  // Only the process group created by this invocation; never a host-wide kill.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}, 180000);
let result;
try {
  result = await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  });
} finally {
  clearTimeout(timeout);
  await new Promise((done) => output.end(done));
}
const after = { executable: await hash(executable), asar: await hash(asar) };
const hashes = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (entry.isFile()) hashes.push({ file, sha256: await hash(file) });
  }
}
await inventory(run);
await writeFile(
  join(run, "run.json"),
  JSON.stringify(
    {
      scope:
        "One Linux packaged OAuth case; controlled HTTP peer/browser, zero model requests intended, NOT public authorization",
      started,
      finished: new Date().toISOString(),
      root,
      executable,
      asar,
      appCommit: values.commit,
      command: ["unshare", ...command],
      before,
      after,
      result,
      timedOut,
      evidence: hashes,
    },
    null,
    2,
  ),
  { flag: "wx", mode: 0o600 },
);
assert.deepEqual(after, before, "Executable/ASAR changed");
assert.equal(
  timedOut,
  false,
  "Bounded runner timed out; retain original failure",
);
process.exitCode = result.code === 0 ? 0 : 1;
