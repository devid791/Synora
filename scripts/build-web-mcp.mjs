import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
if (process.platform === "win32") {
  await import("./build-web-mcp-windows.mjs");
  process.exit(0);
}
const exec = promisify(execFile);
const destination = resolve(
  "out/native",
  `${process.platform}-${process.arch}`,
);
await mkdir(destination, { recursive: true });
const executable =
  process.platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp";
const temporary = join(destination, `${randomUUID()}-${executable}`);
const compiler = process.env.SYNORA_WEB_CXX || "c++";
let flags;
if (process.env.SYNORA_WEB_CXX_FLAGS) {
  flags = JSON.parse(process.env.SYNORA_WEB_CXX_FLAGS);
  if (!Array.isArray(flags) || flags.some((x) => typeof x !== "string"))
    throw new Error("SYNORA_WEB_CXX_FLAGS must be a JSON string array");
} else if (process.platform === "darwin") {
  flags = ["-lcurl"];
} else {
  const result = await exec("pkg-config", ["--cflags", "--libs", "libcurl"]);
  flags = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (flags.some((x) => x.includes("\\")))
    throw new Error(
      "Use explicit SYNORA_WEB_CXX_FLAGS JSON for paths containing spaces",
    );
}
const source = "native/web/axiom_codex_web_mcp.cpp";
const args = [
  "-std=c++17",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  source,
  ...flags,
  "-o",
  temporary,
];
try {
  await exec(compiler, args, { timeout: 120000, maxBuffer: 1048576 });
  await rename(temporary, join(destination, executable));
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}
const sha = (data) => createHash("sha256").update(data).digest("hex");
const source_hashes = {};
for (const path of [source, "native/web/axiom_aliced_json.h"])
  source_hashes[path] = sha(await readFile(path));
const receipt = {
  platform: process.platform,
  arch: process.arch,
  executable,
  sha256: sha(await readFile(join(destination, executable))),
  source_hashes,
  compiler,
  flags,
  builtAt: new Date().toISOString(),
};
await writeFile(
  join(destination, "web-mcp-manifest.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify({ ...receipt, destination }, null, 2));
