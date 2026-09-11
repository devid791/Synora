import { lstat, realpath, chmod } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { patchWindowsPty } from "./patch-windows-pty.mjs";

export async function prepareMacPty(projectRoot) {
  const root = await realpath(projectRoot);
  let prepared = 0;
  for (const suffix of [
    "prebuilds/darwin-arm64/spawn-helper",
    "prebuilds/darwin-x64/spawn-helper",
    "build/Release/spawn-helper",
  ]) {
    const helper = join(root, "node_modules/node-pty", suffix);
    const stat = await lstat(helper).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Unexpected node-pty helper file type");
    const actual = await realpath(helper),
      within = relative(root, actual);
    if (within.startsWith("..") || isAbsolute(within))
      throw new Error("node-pty helper is outside this application");
    if ((stat.mode & 0o111) !== 0o111)
      await chmod(actual, (stat.mode & 0o777) | 0o111);
    prepared++;
  }
  if (!prepared) throw new Error("No macOS node-pty spawn-helper is installed");
  return prepared;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.platform === "darwin"
) {
  await prepareMacPty(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(
    "Verified executable permissions on application-owned node-pty helpers.",
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.platform === "win32"
) {
  await patchWindowsPty(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  console.log("Verified pinned Windows PTY lifecycle patch.");
}
