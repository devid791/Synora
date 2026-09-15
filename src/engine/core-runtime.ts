import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { extract, list, type ReadEntry } from "tar";
import lock from "../../docs/core-runtime-lock.json" with { type: "json" };
import payloads from "../../docs/core-runtime-payloads.json" with { type: "json" };
import legacy from "../../docs/core-runtime-legacy.json" with { type: "json" };
import { PROTOCOL_VERSION } from "../shared/contracts";

export interface CorePackage {
  version: string;
  target: string;
  file: string;
  size: number;
  sha256: string;
  files: Record<string, readonly [number, string]>;
}
/** Trusted host-owned runtime resolver; never accepted from renderer requests. */
export interface CoreSelection {
  version: string;
  executable(): Promise<string>;
}
export function corePackage(
  key = `${process.platform}-${process.arch}`,
): CorePackage {
  if (!Object.hasOwn(lock.targets, key) || lock.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(
      `No qualified Core package for ${key} / ${PROTOCOL_VERSION}`,
    );
  const platform = key as keyof typeof lock.targets;
  return {
    ...lock.targets[platform],
    version: lock.version,
    files: payloads[platform] as unknown as CorePackage["files"],
  };
}
/** Retained exact baseline for existing selections and genuine rollback. */
export function legacyCorePackage(key = `${process.platform}-${process.arch}`): CorePackage {
  if (!Object.hasOwn(legacy.targets, key) || legacy.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`No qualified legacy Core package for ${key}`);
  return { ...legacy.targets[key as keyof typeof legacy.targets], version: legacy.version } as unknown as CorePackage;
}
export const BUNDLED_CORE_VERSION = lock.version;
/** Default managed execution follows the bundle, not the generated schema
 * version. An explicitly injected legacy executable still needs its original
 * pin, unless the caller supplies a qualified runtime selection. */
export function selectedCoreVersion(options: { runtime?: CoreSelection; executable?: string }) {
  return options.runtime?.version ?? (options.executable ? PROTOCOL_VERSION : BUNDLED_CORE_VERSION);
}
export async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function directoryNames(spec: CorePackage) {
  const names = new Set<string>();
  for (const name of Object.keys(spec.files)) {
    if (
      !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) ||
      name.split("/").some((p) => p === "." || p === "..")
    )
      throw new Error("Unsafe pinned Core payload path");
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      names.add(parts.join("/"));
    }
  }
  return names;
}
async function regularFile(path: string, size: number, hash: string) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size !== size ||
    (await sha256File(path)) !== hash
  )
    throw new Error(`Core runtime integrity mismatch: ${path}`);
}
export async function verifyCoreArchive(archive: string, spec: CorePackage) {
  await regularFile(archive, spec.size, spec.sha256);
  const directories = directoryNames(spec),
    seen = new Set<string>();
  const failures: string[] = [];
  // Validate the complete package before extracting anything.
  await list({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      const name =
        entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path;
      const folded = name.toLowerCase();
      if (seen.has(folded)) failures.push(`duplicate: ${entry.path}`);
      seen.add(folded);
      if (entry.type === "Directory") {
        if (!directories.has(name) || entry.size !== 0)
          failures.push(`unexpected directory: ${entry.path}`);
      } else if (
        entry.type !== "File" ||
        !Object.hasOwn(spec.files, name) ||
        entry.size !== spec.files[name][0]
      ) {
        failures.push(`unexpected entry/type/size: ${entry.path}`);
      }
    },
  });
  for (const name of Object.keys(spec.files))
    if (!seen.has(name.toLowerCase())) failures.push(`missing: ${name}`);
  if (failures.length)
    throw new Error(
      `Unsafe or incomplete Core package: ${failures.join("; ")}`,
    );
}
export async function verifyCoreInstall(root: string, spec: CorePackage) {
  const directories = directoryNames(spec),
    found = new Set<string>();
  const walk = async (relative = "") => {
    const path = join(root, relative),
      info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Unsafe Core runtime directory: ${path}`);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error(`Unexpected Core runtime link: ${name}`);
      if (entry.isDirectory() && directories.has(name)) await walk(name);
      else if (entry.isFile() && Object.hasOwn(spec.files, name)) {
        await regularFile(join(root, name), ...spec.files[name]);
        found.add(name);
        if (
          process.platform !== "win32" &&
          name !== "codex-package.json" &&
          ((await lstat(join(root, name))).mode & 0o100) === 0
        )
          throw new Error(`Core helper is not executable: ${name}`);
      } else throw new Error(`Unexpected Core runtime payload: ${name}`);
    }
  };
  await walk();
  for (const name of Object.keys(spec.files))
    if (!found.has(name))
      throw new Error(`Missing Core runtime helper: ${name}`);
  const metadata = JSON.parse(
    await readFile(join(root, "codex-package.json"), "utf8"),
  );
  const entrypoint = spec.target.includes("windows")
    ? "bin/codex.exe"
    : "bin/codex";
  if (
    metadata.layoutVersion !== 1 ||
    metadata.version !== spec.version ||
    metadata.target !== spec.target ||
    metadata.variant !== "codex" ||
    metadata.entrypoint !== entrypoint ||
    metadata.pathDir !== "codex-path" ||
    metadata.resourcesDir !== "codex-resources"
  )
    throw new Error(
      "Core package metadata does not match the pinned runtime contract",
    );
  return join(root, entrypoint);
}

async function admitCoreSpace(cache: string, spec: CorePackage) {
  const { bsize, bavail } = await statfs(cache, { bigint: true });
  if (bsize <= 0n || bavail < 0n)
    throw new Error("Cannot determine available Core installation space");
  // Expanded files, rounded to allocation blocks, plus staging directories.
  // This is admission, not a reservation: later write errors must still fail.
  let required = BigInt(directoryNames(spec).size + 1) * bsize;
  for (const [size] of Object.values(spec.files)) {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Invalid pinned Core payload size");
    required += ((BigInt(size) + bsize - 1n) / bsize) * bsize;
  }
  const available = bsize * bavail;
  if (available < required)
    throw Object.assign(
      new Error(
        `Insufficient disk space for Core: need at least ${required} bytes, ${available} available in ${cache}`,
      ),
      { code: "ENOSPC" },
    );
}

function extractCore(archive: string, temporary: string, closed: () => void) {
  return new Promise<void>((resolve, reject) => {
    // tar's file/promise API rejects on the first error, before its other
    // pending writes finish. Own the streams so cleanup waits for actual close.
    const unpack = extract({
      cwd: temporary,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      noChmod: true,
    });
    const input = createReadStream(archive);
    const entries = new Set<ReadEntry>();
    let aborted = false;
    unpack.on("entry", (entry: ReadEntry) => {
      entries.add(entry);
      entry.once("end", () => entries.delete(entry));
      if (aborted) entry.end();
    });
    let firstError: Error | undefined;
    const abort = (error: Error) => {
      firstError ??= error;
      input.destroy();
      unpack.abort(error);
      reject(firstError);
    };
    input.on("error", abort);
    unpack.on("abort", (error: Error) => {
      firstError ??= error;
      input.destroy();
      aborted = true;
      // Parser.abort() alone leaves partial entries' output descriptors open.
      // End their data streams so tar can close them; never publish this tree.
      for (const entry of entries) entry.end();
      reject(firstError);
    });
    unpack.on("error", (error: Error & { tarCode?: string }) => {
      firstError ??= error;
      // Entry I/O errors drain normally. Fatal parse/read/CWD errors may never
      // close: abort promptly, but do not remove a tree still being written.
      if (error.tarCode !== "TAR_ENTRY_ERROR") abort(error);
    });
    unpack.once("close", () => {
      closed();
      input.destroy();
      if (firstError) reject(firstError);
      else resolve();
    });
    // Node pipe() unpipes on recoverable tar errors; keep feeding through EOF.
    input.on("data", (chunk) => {
      if (!unpack.write(chunk)) input.pause();
    });
    unpack.on("drain", () => input.resume());
    input.once("end", () => unpack.end());
  });
}

/** App-owned offline installation; never replaces existing installations. */
export async function installCore(
  archive: string,
  cacheDirectory: string,
  spec: CorePackage,
) {
  directoryNames(spec);
  if (
    !/^[a-f0-9]{64}$/.test(spec.sha256) ||
    !/^[a-zA-Z0-9_.-]+$/.test(spec.target) ||
    !/^[0-9.]+$/.test(spec.version)
  )
    throw new Error("Invalid pinned Core package identity");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const cache = await realpath(cacheDirectory),
    target = join(
      cache,
      `${spec.version}-${spec.target}-${spec.sha256.slice(0, 16)}`,
    );
  let exists = false;
  try {
    await lstat(target);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exists) return verifyCoreInstall(target, spec);
  await verifyCoreArchive(archive, spec);
  await admitCoreSpace(cache, spec);
  const temporary = await mkdtemp(join(cache, ".synora-core-"));
  let extractionClosed = false;
  let failed = false;
  let failure: unknown;
  try {
    await extractCore(archive, temporary, () => {
      extractionClosed = true;
    });
    for (const name of Object.keys(spec.files))
      await chmod(
        join(temporary, name),
        name === "codex-package.json" ? 0o600 : 0o700,
      );
    await verifyCoreInstall(temporary, spec);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (
        !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      // Another app-owned process can win the atomic installation race.
      await verifyCoreInstall(target, spec);
    }
    return join(
      target,
      spec.target.includes("windows") ? "bin/codex.exe" : "bin/codex",
    );
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    try {
      if (!extractionClosed)
        throw new Error(
          `Core extraction did not close; retained uninstalled staging directory ${temporary}`,
        );
      // Only this invocation's exclusive staging directory, never the cache or
      // published target. Allow bounded retries for delayed native file closes.
      await rm(temporary, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (cleanupError) {
      if (failed)
        throw new AggregateError(
          [failure, cleanupError],
          `Core installation failed (${String(failure)}); staging cleanup failed (${String(cleanupError)})`,
          { cause: failure },
        );
      throw cleanupError;
    }
  }
}
const inflight = new Map<string, Promise<string>>();
export async function managedCore(stateDirectory: string, version = BUNDLED_CORE_VERSION) {
  const runtime = process as NodeJS.Process & {
    resourcesPath?: string;
    defaultApp?: boolean;
  };
  const resources = runtime.defaultApp ? undefined : runtime.resourcesPath;
  const archives =
    process.env.SYNORA_CORE_ARCHIVES ||
    (resources
      ? join(resources, "core-packages")
      : resolve("out/core-packages"));
  const cache =
    process.env.SYNORA_CORE_CACHE ||
    join(resolve(stateDirectory), "core-runtime");
  const spec = version === BUNDLED_CORE_VERSION ? corePackage() : legacyCorePackage();
  if (version !== spec.version) throw new Error("Unknown bundled Core version");
  // Keep the previous flat archive path for existing caches and offline rollback.
  // The new bootstrap lives in a versioned directory; neither archive overwrites the other.
  const archive = spec.version === legacy.version
    ? join(archives, spec.file) : join(archives, spec.version, spec.file);
  const key = `${resolve(archive)}\0${resolve(cache)}`;
  if (inflight.has(key)) return inflight.get(key)!;
  const task = installCore(archive, cache, spec);
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
