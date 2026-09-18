// Only disposable native CI worktrees. Never modifies an installed application.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile, lstat } from "node:fs/promises";
import { resolve, relative, join, isAbsolute } from "node:path";
import { list } from "tar";
import assert from "node:assert/strict";
import { compareCoreVersions } from "../src/engine/qualified-core";
import { installCore, sha256File, type CorePackage } from "../src/engine/core-runtime";

assert.equal(process.env.SYNORA_CORE_QUALIFICATION_WORKTREE, "1", "Disposable qualification checkout required");
const runner = process.env.RUNNER_TEMP;
assert.ok(runner, "Runner-owned temporary directory required");
const rel = relative(resolve(runner), process.cwd());
assert.ok(rel && !isAbsolute(rel) && !rel.startsWith(".."), "Refusing a non-temporary source checkout");
const version = process.argv[2]; compareCoreVersions(version, version);
const inventoryOnly = process.argv[3] === "--inventory-only";
const key = inventoryOnly ? process.argv[4] : `${process.platform}-${process.arch}`;
const lock = JSON.parse(await readFile("docs/core-runtime-lock.json", "utf8"));
assert.ok(key && Object.hasOwn(lock.targets, key), "Unsupported platform");
const previous = lock.targets[key];
const response = await fetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`, {
  // The workflow's short-lived read-only token avoids shared-IP anonymous rate
  // limits. It is never attached to asset downloads or followed across redirects.
  redirect: "error", signal: AbortSignal.timeout(15000), headers: {
    Accept: "application/vnd.github+json",
    ...(process.env.SYNORA_CORE_METADATA_TOKEN
      ? { Authorization: `Bearer ${process.env.SYNORA_CORE_METADATA_TOKEN}` } : {}),
  },
});
assert.ok(response.ok, `Official release HTTP ${response.status}`);
assert.ok(response.body);
const metadataReader = response.body.getReader(), metadataChunks: Uint8Array[] = [];
let metadataSize = 0;
try {
  for (;;) {
    const part = await metadataReader.read(); if (part.done) break;
    metadataSize += part.value.length; assert.ok(metadataSize <= 2 * 1024 * 1024, "Oversized release metadata");
    metadataChunks.push(part.value);
  }
} finally { await metadataReader.cancel(); }
const metadataText = Buffer.concat(metadataChunks).toString("utf8");
const metadata = JSON.parse(metadataText);
assert.equal(metadata.tag_name, `rust-v${version}`); assert.equal(metadata.draft, false); assert.equal(metadata.prerelease, false);
const matches = metadata.assets.filter((a: any) => a.name === previous.file && a.state === "uploaded");
assert.equal(matches.length, 1); const asset = matches[0];
assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/);
assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size < 1024 ** 3);
const directory = resolve("out/core-packages", version); await mkdir(directory, { recursive: true });
const archive = join(directory, previous.file);
let size = 0, cached = false;
try {
  const info = await lstat(archive);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Unexpected cached archive type");
  assert.equal(info.size, asset.size, "Cached official asset size mismatch");
  assert.equal(`sha256:${await sha256File(archive)}`, asset.digest, "Cached official asset hash mismatch");
  size = info.size; cached = true;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (!cached) {
const download = await fetch(`https://github.com/openai/codex/releases/download/rust-v${version}/${previous.file}`, { signal: AbortSignal.timeout(300000) });
assert.ok(download.ok && download.body, "Official asset download failed");
const output = await open(archive, "wx", 0o600), digest = createHash("sha256");
const downloadReader = download.body!.getReader();
try {
  for (;;) {
    const part = await downloadReader.read(); if (part.done) break;
    const chunk = part.value;
    size += chunk.length; assert.ok(size <= asset.size, "Oversized official asset");
    digest.update(chunk); await output.writeFile(chunk);
  }
} finally { await downloadReader.cancel(); await output.close(); }
assert.equal(size, asset.size); assert.equal(`sha256:${digest.digest("hex")}`, asset.digest);
}
const files: CorePackage["files"] = Object.create(null), seen = new Set<string>();
let expanded = 0; const failures: string[] = [];
await list({ file: archive, strict: true, onReadEntry(entry) {
  const name = entry.path.replace(/\/$/, "");
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) || name.split("/").some(p => p === "." || p === "..") || seen.has(name.toLowerCase()))
    failures.push("Unsafe or duplicate payload path");
  seen.add(name.toLowerCase()); expanded += entry.size;
  if (seen.size > 4096 || expanded > 2 ** 31) throw Error("Expanded Core payload exceeds bounds");
  if (entry.type === "Directory" && entry.size === 0) return;
  if (entry.type !== "File") { failures.push("Non-regular Core payload"); return; }
  const hash = createHash("sha256"); let bytes = 0;
  entry.on("data", chunk => { bytes += chunk.length; hash.update(chunk); });
  entry.on("end", () => {
    if (bytes !== entry.size) failures.push("Truncated Core payload");
    files[name] = [bytes, hash.digest("hex")];
  });
} });
assert.deepEqual(failures, []);
const spec: CorePackage = { version, target: previous.target, file: previous.file, size, sha256: asset.digest.slice(7), files };
await installCore(archive, resolve("out/core-channel-runtime"), spec);
if (inventoryOnly) {
  // Cross-platform inventory verification does not execute or claim native QA.
  await writeFile(`out/core-inventory-${key}.json`, JSON.stringify(spec, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ version, target: spec.target, status: "official-inventory-verified-not-native-tested" }));
  process.exit(0);
}
// Pin only this native runner's candidate. These generated changes are never
// committed or shipped to users; all test processes see the exact candidate.
const payloads = JSON.parse(await readFile("docs/core-runtime-payloads.json", "utf8"));
if (compareCoreVersions(version, lock.version) > 0) {
  // The pre-provisioned Windows QA home may still select the prior bundle.
  // Preserve that exact baseline as the candidate build's recovery pin rather
  // than invalidating its private sandbox state or copying OS credentials.
  const retained = { ...lock, targets: Object.fromEntries(Object.entries(lock.targets).map(([platform, pin]) =>
    [platform, { ...(pin as object), files: payloads[platform] }])) };
  await writeFile("docs/core-runtime-legacy.json", JSON.stringify(retained, null, 2) + "\n");
}
lock.version = version; lock.source = `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`;
lock.targets[key] = { target: spec.target, file: spec.file, size, sha256: spec.sha256 };
payloads[key] = files;
await writeFile("docs/core-runtime-lock.json", JSON.stringify(lock, null, 2) + "\n");
await writeFile("docs/core-runtime-payloads.json", JSON.stringify(payloads, null, 2) + "\n");
await writeFile("out/core-channel-candidate.json", JSON.stringify(spec, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ version, target: spec.target, sha256: spec.sha256, status: "candidate-not-qualified" }));
