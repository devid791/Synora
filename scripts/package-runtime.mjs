import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import lock from "../docs/core-runtime-lock.json" with { type: "json" };
import legacy from "../docs/core-runtime-legacy.json" with { type: "json" };
async function digest(path) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}
export async function packageRuntime(resources, platform, arch) {
  const key = `${platform}-${arch}`,
    spec = lock.targets[key];
  if (!spec) throw new Error(`No qualified Core archive for package ${key}`);
  const archive = resolve("out/core-packages", lock.version, spec.file),
    info = await lstat(archive);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== spec.size ||
    (await digest(archive)) !== spec.sha256
  )
    throw new Error(
      "The packaged Core archive must match the pinned official SHA256",
    );
  const previous = legacy.targets[key];
  if (!previous) throw new Error(`No retained rollback Core archive for ${key}`);
  const rollbackArchive = resolve("out/core-packages", previous.file);
  const rollbackInfo = await lstat(rollbackArchive);
  if (!rollbackInfo.isFile() || rollbackInfo.isSymbolicLink() ||
      rollbackInfo.size !== previous.size || await digest(rollbackArchive) !== previous.sha256)
    throw new Error("Retained rollback Core archive must match its original official SHA256");
  const helperDirectory = resolve("out/native", key),
    name = platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp";
  const helper = join(helperDirectory, name),
    receipt = JSON.parse(
      await readFile(join(helperDirectory, "web-mcp-manifest.json"), "utf8"),
    );
  if (
    receipt.platform !== platform ||
    receipt.arch !== arch ||
    receipt.sha256 !== (await digest(helper))
  )
    throw new Error(
      "The packaged native web executor does not match its receipt",
    );
  for (const required of [
    "native/web/axiom_codex_web_mcp.cpp",
    "native/web/axiom_aliced_json.h",
  ])
    if (!/^[a-f0-9]{64}$/.test(receipt.source_hashes?.[required] ?? ""))
      throw new Error("Missing native source provenance");
  for (const [file, expected] of Object.entries(receipt.source_hashes ?? {}))
    if ((await digest(resolve(file))) !== expected)
      throw new Error("Native web executor was built from different source");
  await mkdir(join(resources, "core-packages", lock.version), { recursive: true });
  await copyFile(archive, join(resources, "core-packages", lock.version, spec.file));
  await copyFile(rollbackArchive, join(resources, "core-packages", previous.file));
  for (const name of ["LICENSE", "NOTICE"])
    await copyFile(
      resolve("native/licenses/core", name + ".txt"),
      join(resources, "core-packages", name + ".txt"),
    );
  // Core remains an archive so outer app signing never modifies nested binaries.
  // Runtime extraction retains the original platform-specific payload.
  const native = join(resources, "native", key);
  await mkdir(native, { recursive: true });
  await writeFile(
    join(native, name + ".gz"),
    await promisify(gzip)(await readFile(helper)),
  );
  await copyFile(
    join(helperDirectory, "web-mcp-manifest.json"),
    join(native, "web-mcp-manifest.json"),
  );
  if (platform === "win32")
    for (const name of ["libcurl-COPYING.txt", "zlib-LICENSE.txt"])
      await copyFile(join(helperDirectory, name), join(native, name));
}
