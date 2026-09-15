// Immutable input manifest for cross-platform QA. Generated evidence goes only
// to the caller's newly-created QA directory, never into an installed app.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import assert from "node:assert/strict";
const [mode, receiptPath] = process.argv.slice(2);
const root = realpathSync(process.cwd());
const hash = b => createHash("sha256").update(b).digest("hex");
const safePath = file => {
  assert.ok(file && !isAbsolute(file) && !file.split(/[\\/]/).includes(".."));
  const path = resolve(root, file);
  assert.ok(!relative(root, path).startsWith(".."));
  assert.ok(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), file);
  return path;
};
if (mode === "freeze") {
  assert.ok(receiptPath && lstatSync(receiptPath).isDirectory());
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(f => f && f !== "node_modules"))].sort();
  const entries = files.map(file => {
    const b = readFileSync(safePath(file));
    return { file, size: b.length, sha256: hash(b) };
  });
  const receipt = { schema: "synora.qa-source.v1", at: new Date().toISOString(), base: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), entries };
  writeFileSync(join(receiptPath, "source-manifest.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  writeFileSync(join(receiptPath, "source-files.nul"), files.join("\0") + "\0", { flag: "wx" });
  execFileSync("tar", ["-czf", join(receiptPath, "source.tar.gz"), "--null", "-T", join(receiptPath, "source-files.nul")]);
  console.log(JSON.stringify({ files: entries.length, archive: join(receiptPath, "source.tar.gz"), sha256: hash(readFileSync(join(receiptPath, "source.tar.gz"))), manifestSha256: hash(readFileSync(join(receiptPath, "source-manifest.json"))) }));
} else if (mode === "verify") {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.schema, "synora.qa-source.v1");
  for (const entry of receipt.entries) {
    const bytes = readFileSync(safePath(entry.file));
    assert.equal(bytes.length, entry.size, entry.file);
    assert.equal(hash(bytes), entry.sha256, entry.file);
  }
  console.log(JSON.stringify({ files: receipt.entries.length, matches: true }));
} else throw Error("Use freeze DIRECTORY or verify MANIFEST");
