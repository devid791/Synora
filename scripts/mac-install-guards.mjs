import assert from "node:assert/strict";
import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Read-only guards for this delivery workflow, not a generic process killer or
// attestation against a malicious actor with the same filesystem identity.
export async function canonicalReceipt(path, directory) {
  assert.equal(await realpath(directory), directory);
  assert.equal(typeof path, "string", "Native qualification receipt required");
  assert.equal(resolve(path), path, "Receipt path must be canonical");
  assert.ok(path.startsWith(directory + sep) && path.endsWith("/split-native.json"));
  const entry = await lstat(path);
  assert.ok(entry.isFile() && !entry.isSymbolicLink(), "Receipt must be a regular file");
  assert.equal(await realpath(path), path, "Receipt and parents cannot be symlinks");
  return path;
}

export function ownedProcessIds(ps, prefixes, profilePaths = []) {
  const rows = ps.trim().split("\n").filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    assert.ok(match, "Cannot parse process inventory; refusing installation");
    return { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
  });
  // Include detached Core/helpers by their exact Synora paths, and descendants
  // while ancestry is observable. Never print process arguments or credentials.
  const referencesProfile = command => profilePaths.some(path => {
    let offset = command.indexOf(path);
    while (offset !== -1) {
      const before = command[offset - 1], after = command[offset + path.length];
      // ps joins argv without a shell-escaping contract. Accept a bare/quoted
      // directory argument, --data-dir=path, and descendants, not path-lookalikes.
      if ((before === undefined || /[\s='"]/.test(before)) &&
          (after === undefined || /[\s/'"]/.test(after))) return true;
      offset = command.indexOf(path, offset + path.length);
    }
    return false;
  });
  const owned = new Set(rows.filter(row => prefixes.some(prefix =>
    row.command.includes(prefix)) || referencesProfile(row.command)).map(row => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!owned.has(row.pid) && owned.has(row.parent)) {
      owned.add(row.pid);
      changed = true;
    }
  }
  return [...owned].sort((a, b) => a - b);
}
