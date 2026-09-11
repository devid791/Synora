// Verify the delivered container, not just the unpacked build. No installation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const [directory] = process.argv.slice(2);
if (
  process.platform !== "darwin" ||
  !/^out\/production-qa-macos-[a-f0-9]+$/.test(directory ?? "")
)
  throw Error("Expected the owned macOS candidate directory on macOS");
const exec = promisify(execFile);
const run = async (command, args) => {
  const { stdout, stderr } = await exec(command, args, {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};
const digest = async (path) => {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
};
const candidates = (await readdir(directory)).filter((name) =>
  name.endsWith(".dmg"),
);
if (candidates.length !== 1) throw Error("Expected exactly one DMG");
const dmg = resolve(directory, candidates[0]);
await mkdir("out/live-evidence", { recursive: true });
const output = await mkdtemp("out/live-evidence/dmg-");
const mount = await mkdtemp(join(tmpdir(), "synora-dmg-qa-"));
const receipt = {
  schema: "synora.private-dmg-check.v1",
  dmg,
  sha256: await digest(dmg),
  startedAt: new Date().toISOString(),
  mount,
};
let mounted = false,
  failure;
try {
  receipt.verify = await run("hdiutil", ["verify", dmg]);
  receipt.attach = await run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mount,
    dmg,
  ]);
  mounted = true;
  const inside = join(mount, "Synora Harness Desktop.app");
  const relative = "Contents/Resources/app.asar";
  receipt.unpackedAsar = await digest(
    join(directory, "mac-arm64/Synora Harness Desktop.app", relative),
  );
  receipt.dmgAsar = await digest(join(inside, relative));
  if (receipt.dmgAsar !== receipt.unpackedAsar)
    throw Error("DMG differs from the tested app");
  receipt.codesign = await run("codesign", [
    "--verify",
    "--deep",
    "--strict",
    inside,
  ]);
  receipt.signingScope =
    "ad-hoc seal only; no notarization or trusted publisher claim";
} catch (error) {
  failure = error;
  receipt.error = String(error);
} finally {
  if (mounted) {
    try {
      receipt.detach = await run("hdiutil", ["detach", mount]);
      mounted = false;
    } catch (error) {
      failure ??= error;
      receipt.cleanupError = String(error);
    }
  }
  if (!mounted)
    await rmdir(mount).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  receipt.finishedAt = new Date().toISOString();
  receipt.passed = !failure;
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}
console.log(
  JSON.stringify({
    output,
    passed: receipt.passed,
    dmgSha256: receipt.sha256,
    asar: receipt.dmgAsar,
    detached: !mounted,
  }),
);
if (failure) throw failure;
