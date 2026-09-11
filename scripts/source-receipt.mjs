import { execFileSync } from "node:child_process";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const [mode, argument] = process.argv.slice(2);
if (mode === "create") {
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", argument + "^{commit}"],
    { encoding: "utf8" },
  ).trim();
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const files = entries
    .map((entry) => {
      const [header, name] = entry.split("\t");
      return { path: name, blob: header.split(" ")[2] };
    })
    .filter((entry) =>
      /^(src\/|scripts\/|public\/|native\/|docs\/protocol\/|docs\/core-runtime[^/]*\.json$|package(?:-lock)?\.json$|index\.html$|tsconfig\.json$|vite\.config\.)/.test(
        entry.path,
      ),
    );
  const output = "out/compiled-source-receipt.json";
  await writeFile(
    output,
    JSON.stringify(
      { schema: "synora.compiled-source.v1", commit, files },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ output, commit, files: files.length }));
} else if (mode === "verify") {
  const receipt = JSON.parse(await readFile(argument, "utf8"));
  if (
    receipt.schema !== "synora.compiled-source.v1" ||
    !Array.isArray(receipt.files)
  )
    throw new Error("Invalid source receipt");
  const mismatches = [];
  for (const entry of receipt.files) {
    if (
      typeof entry.path !== "string" ||
      !/^[a-zA-Z0-9_./-]+$/.test(entry.path) ||
      entry.path.split("/").includes("..") ||
      path.isAbsolute(entry.path)
    )
      throw new Error("Invalid source receipt path");
    const stat = await lstat(entry.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Unexpected source file type");
    const bytes = await readFile(entry.path);
    const blob = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (blob !== entry.blob) mismatches.push(entry.path);
  }
  console.log(
    JSON.stringify({
      commit: receipt.commit,
      files: receipt.files.length,
      mismatches,
    }),
  );
  if (mismatches.length) process.exitCode = 1;
} else
  throw new Error("Use source-receipt.mjs create COMMIT or verify RECEIPT");
