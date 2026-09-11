import { createHash } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "./core-runtime";

/** Decompress app data after OS signing; never modifies an installed .app bundle. */
export async function unpackNativeWeb(
  directory: string,
  stateDirectory: string,
) {
  const receipt = JSON.parse(
    await readFile(join(directory, "web-mcp-manifest.json"), "utf8"),
  );
  if (
    receipt.platform !== process.platform ||
    receipt.arch !== process.arch ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256)
  )
    throw new Error(
      "Native web runtime receipt has the wrong platform or digest",
    );
  const name =
    process.platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp";
  const cache = join(stateDirectory, "native-web"),
    target = join(cache, receipt.sha256),
    binary = join(target, name);
  const verify = async () => {
    const root = await lstat(target),
      file = await lstat(binary);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      (await sha256File(binary)) !== receipt.sha256
    )
      throw new Error("Native web runtime integrity mismatch");
    return binary;
  };
  let exists = false;
  try {
    await lstat(target);
    exists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (exists) return verify();
  const archive = join(directory, name + ".gz"),
    info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
    throw new Error("Invalid native web runtime archive");
  const bytes = await promisify(gunzip)(await readFile(archive), {
    maxOutputLength: 64 * 1024 * 1024,
  });
  if (createHash("sha256").update(bytes).digest("hex") !== receipt.sha256)
    throw new Error("Native web runtime archive integrity mismatch");
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(cache, ".synora-native-"));
  try {
    await writeFile(join(temporary, name), bytes, { mode: 0o700, flag: "wx" });
    await writeFile(
      join(temporary, "web-mcp-manifest.json"),
      JSON.stringify(receipt),
      { mode: 0o600, flag: "wx" },
    );
    try {
      await rename(temporary, target);
    } catch (e) {
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
          (e as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw e;
    }
    return await verify();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
