// Private package evidence, never a production-ready or full-matrix claim.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { extractFile } from "@electron/asar";
import { receiptArguments } from "./package-receipt-arguments.mjs";

const { directory, reports, suffix } = receiptArguments(process.argv.slice(2));
const app =
  process.platform === "darwin"
    ? join(directory, "mac-arm64/Synora Harness Desktop.app/Contents")
    : join(
        directory,
        process.platform === "win32" ? "win-unpacked" : "linux-unpacked",
      );
const asar = join(
  app,
  process.platform === "darwin" ? "Resources/app.asar" : "resources/app.asar",
);
const executable = join(
  app,
  process.platform === "darwin"
    ? "MacOS/Synora Harness Desktop"
    : process.platform === "win32"
      ? "Synora Harness Desktop.exe"
      : "synora-harness-desktop",
);
async function digest(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
const blobHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "scripts/source-receipt.mjs",
      "verify",
      "out/compiled-source-receipt.json",
    ],
    { encoding: "utf8" },
  ),
);
if (source.mismatches.length) throw Error("Compiled source mismatch");
const asarHash = await digest(asar),
  compiled = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = `${path}/${entry.name}`;
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile()) {
      const sha256 = await digest(file);
      if (blobHash(extractFile(asar, join(...file.split("/")))) !== sha256)
        throw Error(`Packaged dist differs: ${file}`);
      compiled.push({ file, sha256 });
    } else throw Error("Unexpected compiled input type");
  }
}
await visit("dist");
const tests = [];
for (const file of reports) {
  const report = JSON.parse(await readFile(file, "utf8"));
  if (
    report.config.metadata.asar_sha256 !== asarHash ||
    resolve(report.config.metadata.executable) !== resolve(executable)
  )
    throw Error(`Test does not identify this exact package: ${file}`);
  if (
    !report.stats.expected ||
    report.stats.unexpected ||
    report.stats.skipped ||
    report.stats.flaky
  )
    throw Error(`Report has unpassed cases: ${file}`);
  tests.push({ file, sha256: await digest(file), stats: report.stats });
}
const artifacts = [];
for (const name of await readdir(directory)) {
  if (!/\.(dmg|zip|exe|deb)$/.test(name)) continue;
  const path = join(directory, name);
  artifacts.push({
    path,
    bytes: (await stat(path)).size,
    sha256: await digest(path),
  });
}
let signing;
if (process.platform === "darwin") {
  execFileSync("codesign", ["--verify", "--deep", "--strict", join(app, "..")]);
  const { spawnSync } = await import("node:child_process");
  const details = spawnSync(
    "codesign",
    ["-dv", "--verbose=4", join(app, "..")],
    { encoding: "utf8" },
  );
  if (details.status !== 0) throw Error(details.stderr);
  signing = {
    verified: true,
    details: details.stderr,
    notarization: "not_requested",
  };
} else if (process.platform === "win32") {
  const paths = [
    executable,
    ...artifacts.filter((a) => a.path.endsWith(".exe")).map((a) => a.path),
  ];
  signing = paths.map((path) => ({
    path,
    status: execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-AuthenticodeSignature -LiteralPath '${resolve(path).replaceAll("'", "''")}').Status.ToString()`,
      ],
      { encoding: "utf8" },
    ).trim(),
  }));
} else signing = { status: "unsigned_local_deb" };
const receipt = {
  schema: "synora.private-package-subset.v1",
  createdAt: new Date().toISOString(),
  scope:
    "Only the listed checks passed; not a production or complete platform qualification",
  platform: process.platform,
  architecture: process.arch,
  source,
  executable: { path: resolve(executable), sha256: await digest(executable) },
  asar: { path: resolve(asar), sha256: asarHash },
  compiled,
  artifacts,
  tests,
  signing,
  collectorSha256: await digest("tests/fixtures/package-receipt.mjs"),
  collectorArgumentsSha256: await digest(
    "tests/fixtures/package-receipt-arguments.mjs",
  ),
};
await mkdir("out/live-evidence", { recursive: true });
const output = `out/live-evidence/package-${basename(directory)}-${process.platform}${suffix}.json`;
await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  JSON.stringify({
    output,
    source: source.commit,
    compiled: compiled.length,
    artifacts: artifacts.length,
    tests: tests.reduce((n, t) => n + t.stats.expected, 0),
    asar: asarHash,
  }),
);
