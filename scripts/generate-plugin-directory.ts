/** Offline metadata generator. Run with:
 * npx --no-install tsx scripts/generate-plugin-directory.ts out/public-plugins-20260910
 * Add --check to verify the committed seed without writing it.
 * No subprocesses, network, plugin code, instructions or credential files are read.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPluginDirectorySnapshot,
  type PluginDirectorySourceFile,
} from "../src/main/plugin-directory";
import {
  PLUGIN_DIRECTORY_SEED_REVISION,
  PLUGIN_DIRECTORY_MAX_CACHE_BYTES,
  type PluginDirectorySnapshot,
} from "../src/shared/plugin-directory";

const output = fileURLToPath(
  new URL("../src/shared/plugin-directory-seed.json", import.meta.url),
);

async function boundedRead(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw Error("Generator requires bounded regular files, not symlinks");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > limit ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev
    )
      throw Error("Generator input changed during reading");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const part = await handle.read(buffer, size, buffer.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size !== stat.size)
      throw Error("Generator input changed during reading");
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

export async function generatePluginDirectorySeed(
  checkout: string,
  fetchedAt: number,
): Promise<PluginDirectorySnapshot> {
  const root = await realpath(checkout);
  // Inspect only Git's public HEAD/ref identity, never configuration/credentials or hooks.
  const git = join(root, ".git");
  const gitStat = await lstat(git);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
    throw Error("Use the standalone official checkout");
  const head = (await boundedRead(join(git, "HEAD"), 1024))
    .toString("utf8")
    .trim();
  let revision = head;
  if (head.startsWith("ref: ")) {
    const ref = head.slice(5);
    if (ref !== "refs/heads/main")
      throw Error("Generator requires the official main checkout");
    try {
      revision = (await boundedRead(join(git, ref), 1024))
        .toString("utf8")
        .trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const refs = (
        await boundedRead(join(git, "packed-refs"), 128 * 1024)
      ).toString("utf8");
      revision =
        refs
          .split("\n")
          .find((line) => line.endsWith(` ${ref}`))
          ?.split(" ")[0] ?? "";
    }
  }
  if (revision !== PLUGIN_DIRECTORY_SEED_REVISION)
    throw Error("Checkout HEAD does not match the pinned seed revision");
  const files = new Map<string, PluginDirectorySourceFile>();
  let count = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) throw Error("Checkout tree depth limit exceeded");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      if (++count > 30_000) throw Error("Checkout tree count limit exceeded");
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else {
        const stat = await lstat(absolute);
        const path = relative(root, absolute).split(sep).join("/");
        files.set(path, {
          size: stat.size,
          mode: stat.isSymbolicLink()
            ? "120000"
            : stat.isFile()
              ? stat.mode & 0o111
                ? "100755"
                : "100644"
              : "unsupported",
        });
      }
    }
  };
  await walk(root, 0); // Names/stat only; bodies are read exclusively by the allowlisted builder.
  return buildPluginDirectorySnapshot({
    revision,
    files,
    fetchedAt,
    read: async (path, limit) => {
      const absolute = join(root, path),
        canonical = await realpath(absolute);
      if (!canonical.startsWith(root + sep) || canonical !== absolute)
        throw Error("Generator source escaped the checkout or used a symlink");
      return boundedRead(absolute, limit);
    },
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const positional = args.filter((s) => s !== "--check");
  if (positional.length > 1 || positional.some((s) => s.startsWith("--")))
    throw Error("Usage: generate-plugin-directory.ts [checkout] [--check]");
  const checkout =
    positional[0] ??
    join(dirname(dirname(output)), "../out/public-plugins-20260910");
  // Preserve the first generation timestamp for deterministic regeneration/checks.
  let previous: PluginDirectorySnapshot | undefined;
  try {
    previous = JSON.parse(
      (await boundedRead(output, PLUGIN_DIRECTORY_MAX_CACHE_BYTES)).toString(
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fetchedAt =
    previous?.revision === PLUGIN_DIRECTORY_SEED_REVISION
      ? previous.fetchedAt
      : Date.now();
  const snapshot = await generatePluginDirectorySeed(checkout, fetchedAt);
  const bytes = JSON.stringify(snapshot, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > PLUGIN_DIRECTORY_MAX_CACHE_BYTES)
    throw Error("Generated seed exceeds cache limit");
  if (check) {
    if (
      bytes !==
      (await boundedRead(output, PLUGIN_DIRECTORY_MAX_CACHE_BYTES)).toString(
        "utf8",
      )
    )
      throw Error(
        "Bundled seed differs from the checked-out official metadata",
      );
  } else {
    // Mechanical generated output: no executable/configuration files copied.
    await writeFile(output, bytes);
  }
  console.log(
    `${check ? "Verified" : "Generated"} ${snapshot.entries.length} official entries, ${snapshot.entries.filter((e) => e.icon).length} original icons at ${snapshot.revision}`,
  );
}
