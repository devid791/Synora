// One CPU-only read through the original elevated/private-desktop sandbox.
// Reuses the already-prepared QA home. No model, private credential reads,
// sandbox fallback, global policy changes or command rewriting.
import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [input, binary] = process.argv.slice(2);
const suffix = process.argv[4] ?? "baseline";
if (!/^[a-z0-9-]+$/.test(suffix)) throw Error("Invalid receipt suffix");
if (process.platform !== "win32" || !input || !binary)
  throw Error("Windows QA only");
const directory = resolve(input);
if (
  !/^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/.test(
    directory,
  )
)
  throw Error("Unexpected QA home");
const cwd = join(directory, "workspace");
const fixture = join(cwd, "native-check.txt");
await stat(fixture);
const executable = resolve(binary);
await stat(executable);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    [
      "PATH",
      "TEMP",
      "TMP",
      "SYSTEMROOT",
      "WINDIR",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "COMSPEC",
      "PATHEXT",
    ].includes(key.toUpperCase()),
  ),
);
const profile = {
  type: "managed",
  file_system: {
    type: "restricted",
    entries: [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
    ],
  },
  network: "restricted",
};
const args = [
  "--run-as-windows-sandbox",
  "--codex-home",
  join(directory, "state", "app-server", "native-axiom"),
  "--command-cwd",
  cwd,
  "--workspace-root",
  cwd,
  "--permission-profile",
  JSON.stringify(profile),
  "--env-json",
  JSON.stringify(env),
  "--windows-sandbox-level",
  "elevated",
  "--windows-sandbox-private-desktop",
  "--preserve-proxy-settings",
  "--",
  executable,
  "--codex-run-as-fs-helper",
];
const started = Date.now();
const child = spawn(executable, args, {
  cwd,
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
child.stdout.on("data", (b) => (stdout += b));
child.stderr.on("data", (b) => (stderr += b));
child.stdin.on("error", (e) => {
  if (e.code !== "EPIPE") throw e;
});
child.stdin.end(
  JSON.stringify({
    operation: "fs/readFile",
    params: { path: pathToFileURL(fixture).href },
  }) + "\n",
);
console.log(
  JSON.stringify({
    started: new Date(started).toISOString(),
    wrapperPid: child.pid,
  }),
);
const status = await new Promise((accept, reject) => {
  child.on("error", reject);
  child.on("close", accept);
});
const result = {
  at: new Date().toISOString(),
  directory,
  fixture,
  status,
  elapsedMs: Date.now() - started,
  sandbox: "elevated/private-desktop/read-only",
  stdout,
  stderr,
  fixtureUnchanged:
    (await readFile(fixture, "utf8")) === "SYNORA_NATIVE_BEFORE\n",
};
let helperReadVerified = false;
if (status === 0) {
  const response = JSON.parse(stdout.trim());
  helperReadVerified =
    response.status === "ok" &&
    response.payload?.operation === "fs/readFile" &&
    Buffer.from(response.payload.response.dataBase64, "base64").toString(
      "utf8",
    ) === "SYNORA_NATIVE_BEFORE\n";
}
result.helperReadVerified = helperReadVerified;
await writeFile(
  `out/live-evidence/windows-helper-elevated-${suffix}.json`,
  JSON.stringify(result, null, 2),
  { flag: "wx" },
);
console.log(JSON.stringify(result));
if (status !== 0 || !result.fixtureUnchanged || !helperReadVerified)
  process.exitCode = 1;
