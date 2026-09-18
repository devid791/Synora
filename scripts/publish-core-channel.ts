import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { verifyCoreChannel, coreEvidenceHash } from "../src/engine/core-channel";

const run = promisify(execFile);
const reports = process.argv.slice(2);
assert.ok(reports.length >= 1 && reports.length <= 3, "Explicit qualified report paths are required");
const host = process.env.SYNORA_CHANNEL_DEPLOY_HOST ?? "", user = process.env.SYNORA_CHANNEL_DEPLOY_USER ?? "";
assert.match(host, /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/); assert.match(user, /^[a-z_][a-z0-9_-]*$/);
for (const name of ["SYNORA_CHANNEL_SIGNING_KEY", "SYNORA_CHANNEL_DEPLOY_KEY", "SYNORA_CHANNEL_KNOWN_HOSTS"])
  assert.ok(process.env[name], `Missing protected publisher secret ${name}`);
const temporary = await mkdtemp(join(tmpdir(), "synora-core-publish-"));
const identity = join(temporary, "ssh-key"), hosts = join(temporary, "known-hosts"), signer = join(temporary, "signing-key");
try {
  await writeFile(identity, process.env.SYNORA_CHANNEL_DEPLOY_KEY!, { mode: 0o600, flag: "wx" });
  await writeFile(hosts, process.env.SYNORA_CHANNEL_KNOWN_HOSTS!, { mode: 0o600, flag: "wx" });
  await writeFile(signer, process.env.SYNORA_CHANNEL_SIGNING_KEY!, { mode: 0o600, flag: "wx" });
  const sshOptions = ["-i", identity, "-o", `UserKnownHostsFile=${hosts}`, "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  const remote = `${user}@${host}`;
  const previous = join(temporary, "previous.json");
  // No implicit bootstrap/reset. Install the initial signed empty catalog once
  // during channel provisioning. Missing/inaccessible current catalog fails.
  const downloaded = await run("ssh", [...sshOptions, remote, "read"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  await writeFile(previous, downloaded.stdout, { flag: "wx", mode: 0o600 });
  verifyCoreChannel(JSON.parse(await readFile(previous, "utf8")));
  const output = join(temporary, "next.json");
  await run(process.execPath, ["--import", "tsx", "scripts/sign-core-channel.ts", output, previous,
    ...reports.map(p => resolve(p))], {
    env: { ...process.env, SYNORA_CHANNEL_SIGNING_KEY_FILE: signer }, timeout: 60000, maxBuffer: 65536,
  });
  const bytes = await readFile(output); verifyCoreChannel(JSON.parse(bytes.toString()));
  // Forced command: bounded catalog only; compare-and-swap prevents lost writes.
  const hash = coreEvidenceHash(bytes);
  await new Promise<void>((done, reject) => {
    const child = spawn("ssh", [...sshOptions, remote, `publish ${coreEvidenceHash(Buffer.from(downloaded.stdout))} ${hash}`],
      { stdio: ["pipe", "ignore", "pipe"], timeout: 30000 });
    let error = "";
    child.stderr.on("data", b => { if (error.length < 8192) error += b; });
    child.on("error", reject); child.stdin.on("error", reject);
    child.on("close", code => code === 0 ? done() : reject(Error(`Catalog publication failed: ${error}`)));
    child.stdin.end(bytes);
  });
  const check = await run("ssh", [...sshOptions, remote, "read"], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(coreEvidenceHash(Buffer.from(check.stdout)), hash);
  console.log("Signed Core update channel published and read back successfully.");
} finally {
  // Only this process's exact mkdtemp directory, never any caller-supplied path.
  await rm(temporary, { recursive: true, force: true });
}
