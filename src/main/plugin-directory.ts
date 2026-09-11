import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { iconImage } from "../engine/catalog-icon";
import seed from "../shared/plugin-directory-seed.json" with { type: "json" };
import {
  PLUGIN_DIRECTORY_SOURCE_URL,
  PLUGIN_DIRECTORY_MARKETPLACE_PATH,
  PLUGIN_DIRECTORY_MAX_ENTRIES,
  PLUGIN_DIRECTORY_MAX_ICON_BYTES,
  PLUGIN_DIRECTORY_MAX_CACHE_BYTES,
  isPluginDirectoryPath,
  pluginDirectoryRevisionSchema,
  pluginDirectorySnapshotSchema,
  pluginDirectorySourceUrl,
  type PluginDirectoryEntry,
  type PluginDirectorySnapshot,
  type PluginDirectoryLicense,
} from "../shared/plugin-directory";

const API = "https://api.github.com/repos/openai/plugins";
const RAW = "https://raw.githubusercontent.com/openai/plugins";
const MAX_MANIFEST = 64 * 1024,
  MAX_LICENSE = 64 * 1024;
const MAX_TREE = 8 * 1024 * 1024,
  MAX_TREE_ENTRIES = 30_000;
const MAX_REQUESTS = 1024,
  MAX_TRANSFER = 32 * 1024 * 1024;
const MAX_TIMEOUT = 120_000,
  CONCURRENCY = 4;
const licenseName = /^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\.(?:txt|md))?$/i;

class DirectoryError extends Error {}
function fail(message: string): never {
  throw new DirectoryError(message);
}
function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function blobHash(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Directory source is not valid UTF-8.");
  }
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(decode(bytes));
  } catch {
    return fail("Directory source contains malformed JSON.");
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Invalid directory metadata object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail("Directory metadata exceeds its plain-text limit.");
  return value;
}
function sourcePath(value: unknown): string {
  if (typeof value !== "string") fail("Invalid directory source path.");
  const path = value.startsWith("./") ? value.slice(2) : value;
  if (!isPluginDirectoryPath(path))
    fail("Invalid directory source path; traversal is forbidden.");
  return path;
}

/** Host-only inputs shared with the offline generator, never an IPC surface. */
export interface PluginDirectorySourceFile {
  size: number;
  mode: string;
  sha?: string;
}
export interface PluginDirectorySource {
  revision: string;
  files: ReadonlyMap<string, PluginDirectorySourceFile>;
  read: (path: string, limit: number) => Promise<Buffer>;
  fetchedAt: number;
}

async function parallel<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0,
    failed = false;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (!failed) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = await run(items[i]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}

/** Copies only allowlisted display metadata and passive original images.
 * Never reads .app.json, .mcp.json, hooks, code, skills or defaultPrompt bodies. */
export async function buildPluginDirectorySnapshot(
  source: PluginDirectorySource,
): Promise<PluginDirectorySnapshot> {
  const revision = pluginDirectoryRevisionSchema.parse(source.revision);
  const pending = new Map<string, Promise<Buffer>>();
  const file = (path: string, limit: number): PluginDirectorySourceFile => {
    if (!isPluginDirectoryPath(path)) fail("Invalid directory source path.");
    const node = source.files.get(path);
    if (
      !node ||
      node.mode !== "100644" ||
      !Number.isSafeInteger(node.size) ||
      node.size <= 0 ||
      node.size > limit
    )
      fail(
        `Directory source is missing, linked, executable or oversized: ${path}`,
      );
    return node;
  };
  const read = (path: string, limit: number): Promise<Buffer> => {
    const node = file(path, limit);
    if (!pending.has(path))
      pending.set(
        path,
        source.read(path, limit).then((bytes) => {
          if (
            bytes.length !== node.size ||
            (node.sha && blobHash(bytes) !== node.sha)
          )
            fail("Directory source blob does not match its pinned tree.");
          return bytes;
        }),
      );
    return pending.get(path)!;
  };
  const licenses = async (root: string): Promise<PluginDirectoryLicense[]> => {
    const prefix = root ? `${root}/` : "";
    const paths = [...source.files.keys()]
      .filter((path) => {
        const tail = path.startsWith(prefix) ? path.slice(prefix.length) : "";
        return !!tail && !tail.includes("/") && licenseName.test(tail);
      })
      .sort();
    if (paths.length > 8) fail("Directory license count limit exceeded.");
    const result: PluginDirectoryLicense[] = [];
    for (const path of paths) {
      const bytes = await read(path, MAX_LICENSE);
      result.push({
        path,
        sourceUrl: pluginDirectorySourceUrl(revision, path),
        text: decode(bytes),
        sha256: hash(bytes),
      });
    }
    return result;
  };
  const marketplaceBytes = await read(
    PLUGIN_DIRECTORY_MARKETPLACE_PATH,
    MAX_MANIFEST,
  );
  const marketplace = record(json(marketplaceBytes));
  if (
    marketplace.name !== "openai-curated" ||
    !Array.isArray(marketplace.plugins) ||
    !marketplace.plugins.length ||
    marketplace.plugins.length > PLUGIN_DIRECTORY_MAX_ENTRIES
  )
    fail(
      "Invalid official marketplace or directory entry count limit exceeded.",
    );
  const names = new Set<string>();
  const rows = marketplace.plugins.map((value) => {
    const row = record(value),
      name = text(row.name, 128);
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name) || names.has(name))
      fail("Directory marketplace contains invalid or duplicate identities.");
    names.add(name);
    const origin = record(row.source);
    if (!["local", "url", "git-subdir"].includes(String(origin.source)))
      fail("Unsupported marketplace source kind.");
    if (
      origin.source === "local" &&
      sourcePath(origin.path) !== `plugins/${name}`
    )
      fail("Directory source path does not match its identity.");
    return { row, name, origin };
  });
  const entries = await parallel(
    rows,
    async ({ row, name, origin }): Promise<PluginDirectoryEntry> => {
      const root = `plugins/${name}`;
      const local = origin.source === "local";
      const manifestPath = local ? `${root}/.codex-plugin/plugin.json` : null;
      const bytes = manifestPath
        ? await read(manifestPath, MAX_MANIFEST)
        : null;
      const manifest = bytes ? record(json(bytes)) : row;
      if (manifest.name !== name)
        fail("Directory manifest identity does not match the marketplace.");
      const ui = manifest.interface == null ? {} : record(manifest.interface);
      const author = manifest.author == null ? {} : record(manifest.author);
      const app = source.files.get(`${root}/.app.json`);
      if (local && app) file(`${root}/.app.json`, MAX_MANIFEST); // Presence only: no grants/configuration read.
      if (
        local &&
        manifest.apps != null &&
        (manifest.apps !== "./.app.json" || !app)
      )
        fail(
          "Directory manifest has an unsupported or missing app declaration.",
        );
      let icon: PluginDirectoryEntry["icon"] = null;
      let iconPath: string | null = null;
      let iconSourceField: PluginDirectoryEntry["iconSourceField"] = null;
      const candidates: {
        path: string;
        field: "logo" | "composerIcon" | "logoDark";
      }[] = [];
      let iconError: string | undefined;
      if (local)
        for (const field of ["logo", "composerIcon", "logoDark"] as const) {
          if (ui[field] == null || ui[field] === "") continue;
          const relative = sourcePath(ui[field]);
          if (
            !/^(?:\.codex-plugin\/)?assets\/.+\.(?:png|svg|jpe?g|gif|webp|ico)$/i.test(
              relative,
            )
          )
            fail(
              "Directory icon must be a declared passive asset inside its plugin.",
            );
          // Validate path syntax, but fetch/size-check only the preferred original icon.
          // Some unused composer variants exceed the image limit (e.g. Canva's 1 MB asset).
          const path = `${root}/${relative}`;
          if (!candidates.some((c) => c.path === path))
            candidates.push({ path, field });
        }
      for (const candidate of candidates) {
        const bytes = await read(
          candidate.path,
          PLUGIN_DIRECTORY_MAX_ICON_BYTES,
        );
        try {
          icon = iconImage(bytes);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (
            !["ICON_SIZE", "ICON_DIMENSIONS", "ICON_FORMAT"].includes(
              code ?? "",
            )
          )
            throw error;
          iconError = `Original ${candidate.field} rejected by image validation (${code}).`;
          continue;
        }
        iconPath = candidate.path;
        iconSourceField = candidate.field;
        if (iconError)
          iconError += ` Using the declared ${candidate.field} asset.`;
        break;
      }
      if (candidates.length && !icon)
        fail(`No declared safe image is available for plugins/${name}.`);
      const keywords = manifest.keywords ?? [];
      if (!Array.isArray(keywords) || keywords.length > 64)
        fail("Directory keyword count limit exceeded.");
      return {
        id: `${name}@openai-curated`,
        name,
        displayName: text(ui.displayName, 256, name),
        description: text(
          manifest.description,
          16 * 1024,
          text(ui.shortDescription, 16 * 1024),
        ),
        version:
          local && manifest.version != null
            ? text(manifest.version, 128)
            : null,
        category: text(row.category, 128, text(ui.category, 128)),
        sourceUrl: pluginDirectorySourceUrl(
          revision,
          manifestPath ?? PLUGIN_DIRECTORY_MARKETPLACE_PATH,
        ),
        icon,
        requiresAccount: local && !!app,
        ...(iconError
          ? { iconError }
          : !icon
            ? {
                iconError: local
                  ? "No local original icon declared in the official manifest."
                  : "External manifest and icon are not present in the fixed official repository.",
              }
            : {}),
        metadataOrigin: local ? "manifest" : "marketplace",
        manifestPath,
        manifestSha256: bytes ? hash(bytes) : null,
        declaredSourceKind: origin.source as "local" | "url" | "git-subdir",
        declaredSourceUrl: local ? null : text(origin.url, 2048),
        declaredSourcePath:
          origin.path == null ? null : sourcePath(origin.path),
        accountRequirementKnown: local,
        developerName:
          text(ui.developerName, 256, text(author.name, 256)) || null,
        homepage:
          text(manifest.homepage, 2048, text(ui.websiteURL, 2048)) || null,
        license: text(manifest.license, 512) || null,
        licenseFiles: local ? await licenses(root) : [],
        iconPath,
        iconSourceField,
        keywords: keywords.map((k) => text(k, 128)),
      };
    },
  );
  const repositoryLicenseFiles = await licenses("");
  return validateSnapshot({
    sourceUrl: PLUGIN_DIRECTORY_SOURCE_URL,
    revision,
    fetchedAt: source.fetchedAt,
    entries,
    checking: false,
    error: null,
    marketplaceSha256: hash(marketplaceBytes),
    repositoryLicenseFiles,
    repositoryLicenseNote: repositoryLicenseFiles.length
      ? "Original repository license/notice text retained; individual manifest licenses may differ."
      : "No root license file in this revision. Individual manifest declarations and available plugin-root license/notice texts are retained; missing licenses are not inferred.",
  });
}

function validateSnapshot(value: unknown): PluginDirectorySnapshot {
  const snapshot = pluginDirectorySnapshotSchema.parse(value);
  if (snapshot.checking || snapshot.error !== null)
    fail("Persisted directory must be a completed valid snapshot.");
  for (const e of snapshot.entries) {
    if (e.icon) {
      const image = iconImage(
        Buffer.from(e.icon.dataUrl.split(",")[1], "base64"),
      );
      if (image.dataUrl !== e.icon.dataUrl || image.sha256 !== e.icon.sha256)
        fail("Directory icon integrity check failed.");
    }
    for (const l of e.licenseFiles ?? [])
      if (hash(Buffer.from(l.text)) !== l.sha256)
        fail("Directory license integrity check failed.");
  }
  for (const l of snapshot.repositoryLicenseFiles ?? [])
    if (hash(Buffer.from(l.text)) !== l.sha256)
      fail("Directory license integrity check failed.");
  return snapshot;
}

export interface PluginDirectoryOptions {
  /** Host-only injection; never pass preferences or renderer input here. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Whole-refresh milliseconds, clamped to at most 120 seconds. */
  timeout?: number;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ?? new DirectoryError("Directory request cancelled."),
      );
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Public source metadata only. No shell, provider, Core, account or install APIs. */
export class PluginDirectory {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private current: PluginDirectorySnapshot;
  private loading?: Promise<void>;
  private pending?: Promise<PluginDirectorySnapshot>;
  private controller?: AbortController;
  private checking = false;
  private error: string | null = null;
  private disposed = false;

  constructor(
    private readonly cachePath: string,
    options: PluginDirectoryOptions = {},
  ) {
    if (
      Object.keys(options).some((k) => !["fetch", "now", "timeout"].includes(k))
    )
      throw Error(
        "Only host-owned fetch, now and timeout options are supported.",
      );
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) || options.timeout <= 0)
    )
      throw Error("Invalid directory timeout.");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeout = Math.max(
      1,
      Math.min(options.timeout ?? MAX_TIMEOUT, MAX_TIMEOUT),
    );
    this.current = validateSnapshot(seed);
  }
  private snapshot(): PluginDirectorySnapshot {
    return structuredClone({
      ...this.current,
      checking: this.checking,
      error: this.error,
    });
  }
  /** Disk/seed only; never waits for network refresh or requires a workspace/grant. */
  async read(): Promise<PluginDirectorySnapshot> {
    if (arguments.length) this.error = "Directory read accepts no arguments.";
    await this.load();
    return this.snapshot();
  }
  /** Deduplicated, all-or-nothing refresh. Failures resolve with last valid data and error. */
  refresh(): Promise<PluginDirectorySnapshot> {
    if (arguments.length || this.disposed) {
      this.error = this.disposed
        ? "Plugin directory is disposed."
        : "Directory refresh accepts no arguments.";
      return Promise.resolve(this.snapshot());
    }
    if (this.pending) return this.pending;
    this.checking = true;
    this.controller = new AbortController();
    const controller = this.controller;
    const timer = setTimeout(
      () =>
        controller.abort(
          new DirectoryError("Plugin directory refresh exceeded its deadline."),
        ),
      this.timeout,
    );
    this.pending = (async () => {
      try {
        await this.load();
        controller.signal.throwIfAborted();
        const snapshot = await this.fetchSnapshot(controller.signal);
        controller.signal.throwIfAborted();
        await this.save(snapshot, controller.signal);
        this.current = snapshot;
        this.error = null;
      } catch (error) {
        const reason = controller.signal.aborted
          ? controller.signal.reason
          : error;
        this.error =
          reason instanceof DirectoryError
            ? reason.message
            : "Public plugin directory refresh failed (invalid metadata, image, network or storage); previous data retained.";
      } finally {
        clearTimeout(timer);
        controller.abort(); // Stop remaining workers/readers after any failure.
        this.checking = false;
        this.controller = undefined;
      }
      return this.snapshot();
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort(new DirectoryError("Plugin directory is disposed."));
    await this.pending;
    await this.loading;
  }
  private load(): Promise<void> {
    return (this.loading ??= this.loadDisk());
  }
  private async loadDisk(): Promise<void> {
    let handle;
    try {
      const before = await lstat(this.cachePath);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.size > PLUGIN_DIRECTORY_MAX_CACHE_BYTES
      )
        fail("Invalid directory cache file.");
      handle = await open(
        this.cachePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > PLUGIN_DIRECTORY_MAX_CACHE_BYTES ||
        stat.ino !== before.ino ||
        stat.dev !== before.dev
      )
        fail("Invalid directory cache file.");
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== stat.size) fail("Directory cache changed during reading.");
      const cache = z
        .object({ version: z.literal(1), snapshot: z.unknown() })
        .strict()
        .parse(json(bytes.subarray(0, offset)));
      this.current = validateSnapshot(cache.snapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.error =
          "Plugin directory cache is invalid or unreadable; bundled metadata retained.";
    } finally {
      await handle?.close();
    }
  }
  private async save(
    snapshot: PluginDirectorySnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const bytes = Buffer.from(JSON.stringify({ version: 1, snapshot }));
    if (bytes.length > PLUGIN_DIRECTORY_MAX_CACHE_BYTES)
      fail("Directory cache byte limit exceeded.");
    signal.throwIfAborted();
    await mkdir(dirname(this.cachePath), { recursive: true });
    const temporary = `${this.cachePath}.${randomUUID()}.tmp`;
    let owned = false;
    try {
      signal.throwIfAborted();
      const handle = await open(temporary, "wx", 0o600);
      owned = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      await rename(temporary, this.cachePath);
    } finally {
      if (owned)
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
  private async fetchSnapshot(
    signal: AbortSignal,
  ): Promise<PluginDirectorySnapshot> {
    let requests = 0,
      total = 0;
    const get = async (url: string, limit: number): Promise<Buffer> => {
      signal.throwIfAborted();
      // Only URLs constructed below are allowed; remote manifest URLs are display metadata.
      const allowed =
        url === `${API}/git/ref/heads/main` ||
        new RegExp(`^${API}/git/commits/[a-f0-9]{40}$`).test(url) ||
        new RegExp(`^${API}/git/trees/[a-f0-9]{40}\\?recursive=1$`).test(url) ||
        (url.startsWith(`${RAW}/`) &&
          /^[a-f0-9]{40}\//.test(url.slice(RAW.length + 1)) &&
          isPluginDirectoryPath(url.slice(RAW.length + 42)));
      if (!allowed) fail("Non-official directory request rejected.");
      if (++requests > MAX_REQUESTS)
        fail("Directory request count limit exceeded.");
      const requestController = new AbortController();
      const requestSignal = AbortSignal.any([signal, requestController.signal]);
      const timer = setTimeout(
        () =>
          requestController.abort(
            new DirectoryError(
              "Plugin directory request exceeded its deadline.",
            ),
          ),
        Math.min(this.timeout, 15_000),
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await abortable(
          this.fetcher(url, {
            method: "GET",
            signal: requestSignal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            headers: {
              Accept: "application/json,image/*,text/plain",
              "Accept-Encoding": "identity",
            },
          }),
          requestSignal,
        );
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          response.status !== 200 ||
          !response.body
        ) {
          void response.body?.cancel().catch(() => {});
          fail(
            "Official directory HTTP request failed or attempted a redirect.",
          );
        }
        const length = response.headers.get("content-length"),
          encoding = response.headers.get("content-encoding");
        if (
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > limit)) ||
          (encoding && encoding !== "identity")
        ) {
          void response.body.cancel().catch(() => {});
          fail("Directory response is oversized or encoded unexpectedly.");
        }
        reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let size = 0;
        while (true) {
          const chunk = await abortable(reader.read(), requestSignal);
          if (chunk.done) break;
          size += chunk.value.byteLength;
          total += chunk.value.byteLength;
          if (size > limit || total > MAX_TRANSFER)
            fail("Directory response byte limit exceeded.");
          chunks.push(Buffer.from(chunk.value));
        }
        if (!size || (length !== null && Number(length) !== size))
          fail("Directory response is empty or truncated.");
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
        void reader?.cancel().catch(() => {});
      }
    };
    const sha = pluginDirectoryRevisionSchema;
    const ref = z
      .object({
        ref: z.literal("refs/heads/main"),
        object: z.object({ type: z.literal("commit"), sha }),
      })
      .parse(json(await get(`${API}/git/ref/heads/main`, 16 * 1024)));
    const revision = ref.object.sha;
    // The bundled seed and disk cache have already passed structural/image/hash checks.
    // Immutable Git revisions do not need their 65 manifests/assets downloaded every 6h.
    if (revision === this.current.revision)
      return validateSnapshot({
        ...this.current,
        fetchedAt: this.now(),
        checking: false,
        error: null,
      });
    const commit = z
      .object({ sha, tree: z.object({ sha }) })
      .parse(json(await get(`${API}/git/commits/${revision}`, 128 * 1024)));
    if (commit.sha !== revision) fail("Directory commit revision mismatch.");
    const tree = z
      .object({
        sha,
        truncated: z.literal(false),
        tree: z
          .array(
            z.object({
              path: z.string().min(1).max(2048),
              mode: z.string(),
              type: z.enum(["tree", "blob", "commit"]),
              sha,
              size: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER)
                .optional(),
            }),
          )
          .max(MAX_TREE_ENTRIES),
      })
      .parse(
        json(
          await get(
            `${API}/git/trees/${commit.tree.sha}?recursive=1`,
            MAX_TREE,
          ),
        ),
      );
    if (tree.sha !== commit.tree.sha) fail("Directory tree revision mismatch.");
    const files = new Map<string, PluginDirectorySourceFile>(),
      seen = new Set<string>();
    for (const node of tree.tree) {
      if (
        seen.has(node.path) ||
        node.path.startsWith("/") ||
        node.path.split("/").some((p) => !p || p === "." || p === "..") ||
        /[\\\x00-\x1f]/.test(node.path)
      )
        fail("Directory tree contains duplicate or unsafe paths.");
      seen.add(node.path);
      if (node.type !== "tree")
        files.set(node.path, {
          size: node.size ?? -1,
          sha: node.sha,
          mode: node.mode,
        });
    }
    return buildPluginDirectorySnapshot({
      revision,
      files,
      fetchedAt: this.now(),
      read: (path, limit) => get(`${RAW}/${revision}/${path}`, limit),
    });
  }
}
