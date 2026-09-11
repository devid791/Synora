import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extract, list } from "tar";
import lock from "../native/web/curl-lock.json" with { type: "json" };
import zlib from "../native/web/zlib-lock.json" with { type: "json" };
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Windows x64 builder required");
await import("./download-curl.mjs");
const dependencyRoot = resolve("out/native-deps");
for (const [prefix, dependency] of [
  ["curl", lock],
  ["zlib", zlib],
]) {
  const archive = join(dependencyRoot, dependency.file);
  const failures = [];
  await list({
    file: archive,
    strict: true,
    onReadEntry(e) {
      if (
        !e.path.startsWith(`${prefix}-${dependency.version}/`) ||
        e.path.includes("\\") ||
        e.path.split("/").includes("..") ||
        !["File", "Directory"].includes(e.type)
      )
        failures.push(e.path);
    },
  });
  if (failures.length)
    throw new Error(
      "Unexpected libcurl archive entries: " + failures.join(","),
    );
  await extract({
    file: archive,
    cwd: dependencyRoot,
    strict: true,
    preserveOwner: false,
  });
}
const source = join(dependencyRoot, `curl-${lock.version}`),
  build = resolve("out/native-build/win32-x64"),
  destination = resolve("out/native/win32-x64");
const cmake = process.env.SYNORA_CMAKE || "cmake",
  exec = promisify(execFile);
const configure = [
  "-S",
  resolve("native/web"),
  "-B",
  build,
  "-G",
  "Visual Studio 17 2022",
  "-A",
  "x64",
  `-DSYNORA_CURL_SOURCE=${source.replaceAll("\\", "/")}`,
  `-DSYNORA_ZLIB_SOURCE=${join(dependencyRoot, `zlib-${zlib.version}`).replaceAll("\\", "/")}`,
];
await mkdir(destination, { recursive: true });
for (const args of [
  configure,
  [
    "--build",
    build,
    "--config",
    "Release",
    "--target",
    "synora-web-mcp",
    "--parallel",
    "4",
  ],
]) {
  const result = await exec(cmake, args, {
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
}
const executable = "synora-web-mcp.exe";
await copyFile(
  join(build, "Release", executable),
  join(destination, executable),
);
const sha = (data) => createHash("sha256").update(data).digest("hex"),
  source_hashes = {};
for (const path of [
  "native/web/axiom_codex_web_mcp.cpp",
  "native/web/axiom_aliced_json.h",
  "native/web/CMakeLists.txt",
  "native/web/curl-lock.json",
  "native/web/zlib-lock.json",
])
  source_hashes[path] = sha(await readFile(path));
const receipt = {
  platform: process.platform,
  arch: process.arch,
  executable,
  sha256: sha(await readFile(join(destination, executable))),
  source_hashes,
  compiler: "MSVC 2022 via CMake",
  configure,
  libcurl: {
    version: lock.version,
    source_sha256: lock.sha256,
    tls: "Schannel",
    linkage: "static",
    asyncDns: true,
  },
  builtAt: new Date().toISOString(),
  zlib: {
    version: zlib.version,
    source_sha256: zlib.sha256,
    linkage: "static",
  },
};
await writeFile(
  join(destination, "web-mcp-manifest.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
await copyFile(
  join(source, "COPYING"),
  join(destination, "libcurl-COPYING.txt"),
);
console.log(JSON.stringify(receipt));
await copyFile(
  join(dependencyRoot, `zlib-${zlib.version}`, "LICENSE"),
  join(destination, "zlib-LICENSE.txt"),
);
