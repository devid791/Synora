import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";

/** An environment variable alone is never proof of network isolation. */
export async function assertControlledNetwork() {
  if (process.platform === "win32") {
    const path = process.env.SYNORA_QA_NETWORK_PROOF ?? "";
    assert.match(
      path,
      /^C:\\ProgramData\\Synora-QA-Network\\[0-9a-f]{32}\\proof.json$/,
    );
    const result = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        "tests/fixtures/windows-qa-network.ps1",
        "-Action",
        "Verify",
        "-Proof",
        path,
      ],
      { timeout: 15000 },
    );
    const proof = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    assert.equal(
      proof.files[0].path.toLowerCase(),
      process.execPath.toLowerCase(),
    );
    const probe = await promisify(execFile)(
      process.execPath,
      [
        "tests/fixtures/windows-qa-probe.mjs",
        proof.host,
        String(proof.tcp),
        String(proof.udp),
      ],
      { timeout: 5000 },
    );
    const actual = JSON.parse(probe.stdout);
    for (const v of [actual.tcp, actual.udp])
      assert.ok(
        ["timeout", "EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH"].includes(
          v,
        ),
      );
    return;
  }
  if (process.platform !== "darwin") {
    assert.deepEqual(Object.keys(networkInterfaces()).sort(), ["lo"]);
    return;
  }
  const path = process.env.SYNORA_QA_NETWORK_PROOF ?? "";
  assert.match(
    path,
    /^\/private\/var\/tmp\/synora-network-[A-Za-z0-9]+\/proof.json$/,
  );
  for (const entry of [path, dirname(path)]) {
    const stat = await lstat(entry);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o022, 0);
    assert.equal(stat.isSymbolicLink(), false);
  }
  const proof = JSON.parse(await readFile(path, "utf8"));
  assert.equal(proof.schema, "synora.qa-network.v1");
  assert.equal(proof.uid, process.getuid!());
  assert.equal(proof.gid, process.getgid!());
  assert.equal(proof.gid, process.getegid!());
  assert.equal(proof.gid, 64080);
  assert.ok(proof.expires > Date.now() && proof.expires <= Date.now() + 420000);
  for (const p of [proof.before, proof.after]) {
    assert.equal(p.tcp, "allowed");
    assert.equal(p.udp, "allowed");
  }
  const result = await promisify(execFile)(
    process.execPath,
    [
      "tests/fixtures/macos-qa-probe.mjs",
      proof.host,
      String(proof.tcp),
      String(proof.udp),
    ],
    { timeout: 5000 },
  );
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.gid, proof.gid);
  assert.equal(actual.egid, proof.gid);
  for (const value of [actual.tcp, actual.udp])
    assert.ok(
      ["timeout", "EHOSTUNREACH", "ECONNREFUSED", "EACCES", "EPERM"].includes(
        value,
      ),
    );
}
