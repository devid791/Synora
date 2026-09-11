import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep, join } from "node:path";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import type { CoreCatalogSnapshot } from "../shared/core-catalog";
import type { CatalogIcon, CatalogIconRequest } from "../shared/catalog-icon";

const MAX_BYTES = 512 * 1024,
  MAX_CACHE = 8 * 1024 * 1024;
type Source =
  | { kind: "local"; root: string; path: string; field: string }
  | { kind: "https"; url: string; field: string };
class IconError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string): never => {
  throw new IconError(code, message);
};

/** Resolves original metadata only. No install, account lookup or model request. */
export function catalogIconSources(
  snapshot: CoreCatalogSnapshot | null,
  key: CatalogIconRequest,
  trustedCacheRoot?: string,
): Source[] {
  if (
    !snapshot ||
    snapshot.id !== key.catalogId ||
    snapshot.busy ||
    snapshot.cancelled
  )
    return fail(
      "ICON_CATALOG_STALE",
      "Read the current Core catalog before loading its icons.",
    );
  const result: Source[] = [];
  const remote = (url: string | null | undefined, field: string) => {
    if (url) result.push({ kind: "https", url, field });
  };
  if (key.kind === "plugin") {
    const matches =
      snapshot.plugins?.marketplaces
        .filter((m) => m.name === key.marketplace)
        .flatMap((m) => m.plugins.filter((p) => p.id === key.id)) ?? [];
    if (matches.length !== 1)
      return fail(
        "ICON_IDENTITY",
        "Original plugin identity is missing or ambiguous.",
      );
    const p = matches[0],
      i = p.interface;
    if (!i) return [];
    const local = (path: string | null, field: string) => {
      if (!path) return;
      if (p.source.type === "local" && contained(p.source.path, path)) {
        result.push({ kind: "local", path, root: p.source.path, field });
        return;
      }
      // Original Core materializes local/git/npm packages under
      // CODEX_HOME/plugins/cache/<marketplace>/<name>/<version>. The host owns
      // CODEX_HOME; the renderer cannot supply a cache root or asset path.
      if (
        trustedCacheRoot &&
        p.installed &&
        [key.marketplace, p.name].every(
          (n) => !!n && n !== "." && n !== ".." && !/[\\/]/.test(n),
        )
      ) {
        const base = join(trustedCacheRoot, key.marketplace!, p.name);
        if (contained(base, path)) {
          const version = relative(base, path).split(sep)[0];
          const root = join(base, version);
          if (contained(root, path)) {
            result.push({ kind: "local", path, root, field });
            return;
          }
        }
      }
      // Retain the declared local source so invalid traversal produces a clear
      // error rather than pretending Core did not report an icon.
      if (p.source.type === "local")
        result.push({ kind: "local", path, root: p.source.path, field });
    };
    if (key.theme === "dark") {
      local(i.logoDark, "logoDark");
      remote(i.logoUrlDark, "logoUrlDark");
    }
    local(i.logo, "logo");
    remote(i.logoUrl, "logoUrl");
    local(i.composerIcon, "composerIcon");
    remote(i.composerIconUrl, "composerIconUrl");
    if (key.theme === "light") {
      local(i.logoDark, "logoDark");
      remote(i.logoUrlDark, "logoUrlDark");
    }
    if (!result.length && (i.logo || i.logoDark || i.composerIcon))
      return fail(
        "ICON_PACKAGE_ROOT",
        "Core reported a local icon without a verified package root in this provider.",
      );
  } else {
    if (key.marketplace)
      return fail(
        "ICON_IDENTITY",
        "Connector identities do not have a marketplace.",
      );
    const apps = snapshot.apps?.data.filter((a) => a.id === key.id) ?? [];
    if (
      apps.length === 0 &&
      snapshot.installedApps?.apps.some((a) => a.id === key.id)
    )
      return [];
    if (apps.length !== 1)
      return fail(
        "ICON_IDENTITY",
        "Original connector identity is missing or ambiguous.",
      );
    const a = apps[0];
    const assets = (map: typeof a.iconAssets, field: string) => {
      // Original Core connector fixture specifies 256_square, not a guessed logo URL.
      const keys = Object.keys(map ?? {}).sort((a, b) => a.localeCompare(b));
      if (keys.includes("256_square"))
        (keys.splice(keys.indexOf("256_square"), 1),
          keys.unshift("256_square"));
      for (const k of keys) remote(map![k], `${field}.${k}`);
    };
    if (key.theme === "dark") {
      assets(a.iconDarkAssets, "iconDarkAssets");
      remote(a.logoUrlDark, "logoUrlDark");
    }
    assets(a.iconAssets, "iconAssets");
    remote(a.logoUrl, "logoUrl");
    if (key.theme === "light") {
      assets(a.iconDarkAssets, "iconDarkAssets");
      remote(a.logoUrlDark, "logoUrlDark");
    }
  }
  const seen = new Set<string>();
  return result.filter((s) => {
    const k = JSON.stringify(s.kind === "local" ? [s.root, s.path] : s.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const forbidden = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  forbidden.addSubnet(address, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
forbidden.addSubnet("2001::", 23, "ipv6");
forbidden.addSubnet("2002::", 16, "ipv6");
forbidden.addSubnet("2001:db8::", 32, "ipv6");
forbidden.addSubnet("3fff::", 20, "ipv6");
export function isPublicIconAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !forbidden.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !forbidden.check(address, "ipv6");
}
export function iconUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("ICON_URL", "Invalid original icon URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.href.length > 8192 ||
    url.hash ||
    (isIP(host) && !isPublicIconAddress(host))
  )
    return fail(
      "ICON_URL",
      "Remote icons require a public HTTPS URL without credentials.",
    );
  return url;
}

/** Fresh DNS per redirect, pinned approved address per socket, normal TLS hostname validation.
 * No proxy environment, cookies, auth, referrer or cross-origin credential propagation. */
export async function readRemoteIcon(
  value: string,
  signal: AbortSignal,
  network: {
    lookup: (host: string, options: { all: true }) => Promise<LookupAddress[]>;
    request: typeof request;
  } = { lookup, request },
): Promise<Buffer> {
  let url = iconUrl(value);
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await abortable(network.lookup(host, { all: true }), signal);
    signal.throwIfAborted();
    if (
      !addresses.length ||
      addresses.some((a) => !isPublicIconAddress(a.address))
    )
      return fail(
        "ICON_ADDRESS",
        "Icon hostname does not resolve exclusively to public addresses.",
      );
    const address = addresses[0];
    const response = await new Promise<{ redirect?: string; body?: Buffer }>(
      (resolve, reject) => {
        const req = network.request(
          url,
          {
            signal,
            agent: false,
            rejectUnauthorized: true,
            lookup: ((
              _host: string,
              options: { all?: boolean },
              cb: Function,
            ) => {
              if (options.all) cb(null, [address]);
              else cb(null, address.address, address.family);
            }) as NonNullable<Parameters<typeof request>[1]>["lookup"],
            headers: {
              Accept:
                "image/svg+xml,image/png,image/jpeg,image/webp,image/gif,image/x-icon",
              "Accept-Encoding": "identity",
            },
          },
          (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
              const redirect = res.headers.location;
              res.destroy();
              if (!redirect)
                reject(
                  new IconError(
                    "ICON_HTTP",
                    "Icon redirect has no destination.",
                  ),
                );
              else resolve({ redirect });
              return;
            }
            if (
              res.statusCode !== 200 ||
              Number(res.headers["content-length"]) > MAX_BYTES ||
              (res.headers["content-encoding"] &&
                res.headers["content-encoding"] !== "identity")
            ) {
              res.destroy();
              reject(
                new IconError(
                  "ICON_HTTP",
                  "Original icon was unavailable or exceeded the image limit.",
                ),
              );
              return;
            }
            let size = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_BYTES) {
                res.destroy();
                reject(
                  new IconError(
                    "ICON_SIZE",
                    "Original icon exceeds the image limit.",
                  ),
                );
              } else chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
            res.on("aborted", () =>
              reject(
                new IconError(
                  "ICON_HTTP",
                  "Original icon transfer was interrupted.",
                ),
              ),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    if (response.body) return response.body;
    url = iconUrl(new URL(response.redirect!, url).href);
  }
  return fail("ICON_REDIRECT", "Original icon redirected too many times.");
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) {
      operation.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function contained(root: string, path: string) {
  const r = relative(root, path);
  return !!r && !isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`);
}
export async function readLocalIcon(
  root: string,
  path: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!isAbsolute(root) || !isAbsolute(path) || !contained(root, path))
    return fail("ICON_PATH", "Original icon is outside its plugin package.");
  const base = await realpath(root),
    actual = await realpath(path);
  if (!contained(base, actual))
    return fail(
      "ICON_PATH",
      "Original icon resolves outside its plugin package.",
    );
  const handle = await open(
    actual,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES)
      return fail(
        "ICON_SIZE",
        "Original icon is not a bounded regular image file.",
      );
    // Verify the descriptor's identity against the still-confined path before reading.
    if ((await realpath(path)) !== actual || (await realpath(root)) !== base)
      return fail("ICON_PATH", "Plugin asset path changed during loading.");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_BYTES + 1));
    let count = 0;
    while (count < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        count,
        buffer.length - count,
        count,
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== stat.size)
      return fail(
        "ICON_CHANGED",
        "Original icon changed during loading; retry.",
      );
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

/** Never insert these bytes into HTML. SVG is exclusively an inert img data URL. */
export function iconImage(bytes: Buffer): { dataUrl: string; sha256: string } {
  if (!bytes.length || bytes.length > MAX_BYTES)
    return fail("ICON_SIZE", "Original icon exceeds the image limit.");
  let mime: string | undefined;
  const dimensions = (width: number, height: number) => {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0 ||
      width > 4096 ||
      height > 4096 ||
      width * height > 4 * 1024 * 1024
    )
      return fail(
        "ICON_DIMENSIONS",
        "Original icon dimensions exceed the image limit.",
      );
  };
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (
      bytes.length < 24 ||
      bytes.readUInt32BE(16) > 4096 ||
      bytes.readUInt32BE(20) > 4096
    )
      return fail(
        "ICON_DIMENSIONS",
        "Original icon dimensions exceed the image limit.",
      );
    mime = "image/png";
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    let position = 2,
      found = false;
    while (position + 4 < bytes.length) {
      if (bytes[position++] !== 255) break;
      while (bytes[position] === 255) position++;
      const marker = bytes[position++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (position + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(position);
      if (length < 2 || position + length > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        if (length < 8) break;
        dimensions(
          bytes.readUInt16BE(position + 5),
          bytes.readUInt16BE(position + 3),
        );
        found = true;
        break;
      }
      position += length;
    }
    if (found) mime = "image/jpeg";
  } else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) {
    if (
      bytes.length < 10 ||
      bytes.readUInt16LE(6) > 4096 ||
      bytes.readUInt16LE(8) > 4096
    )
      return fail(
        "ICON_DIMENSIONS",
        "Original icon dimensions exceed the image limit.",
      );
    mime = "image/gif";
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  } else if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const type = bytes.toString("ascii", 12, 16);
    if (type === "VP8X" && bytes.length >= 30) {
      dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
      mime = "image/webp";
    } else if (
      type === "VP8 " &&
      bytes.length >= 30 &&
      bytes.toString("hex", 23, 26) === "9d012a"
    ) {
      dimensions(
        bytes.readUInt16LE(26) & 16383,
        bytes.readUInt16LE(28) & 16383,
      );
      mime = "image/webp";
    } else if (type === "VP8L" && bytes.length >= 25 && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1);
      mime = "image/webp";
    }
  } else if (bytes.length > 6 && bytes.readUInt32LE(0) === 65536) {
    const count = bytes.readUInt16LE(4);
    if (!count || count > 64 || bytes.length < 6 + 16 * count)
      return fail("ICON_FORMAT", "Original icon directory is invalid.");
    for (let n = 0; n < count; n++) {
      const pos = 6 + n * 16;
      if (
        bytes.readUInt32LE(pos + 12) + bytes.readUInt32LE(pos + 8) >
        bytes.length
      )
        return fail("ICON_FORMAT", "Original icon directory is truncated.");
      dimensions(bytes[pos] || 256, bytes[pos + 1] || 256);
    }
    mime = "image/x-icon";
  } else {
    const svg = bytes
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .trim();
    if (
      /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(svg) &&
      !/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject)\b|\bon\w+\s*=/i.test(
        svg,
      )
    ) {
      const root = svg.match(/<svg\b[^>]*>/i)?.[0] ?? "";
      const width = root.match(
        /\bwidth\s*=\s*["']([\d.eE+-]+)(?:px)?["']/,
      )?.[1];
      const height = root.match(
        /\bheight\s*=\s*["']([\d.eE+-]+)(?:px)?["']/,
      )?.[1];
      if (width || height)
        dimensions(Number(width ?? 300), Number(height ?? 150));
      mime = "image/svg+xml";
    }
  }
  if (!mime)
    return fail(
      "ICON_FORMAT",
      "Original asset is not a supported passive image.",
    );
  return {
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export class CatalogIcons {
  private entries = new Map<
    string,
    { at: number; result: CatalogIcon; bytes: number }
  >();
  private pending = new Map<string, Promise<CatalogIcon>>();
  private controllers = new Set<AbortController>();
  private active = 0;
  private queue: (() => void)[] = [];
  private closed = false;
  constructor(
    private remote = readRemoteIcon,
    private deadlineMs = 10000,
  ) {}
  async read(
    snapshot: CoreCatalogSnapshot | null,
    key: CatalogIconRequest,
    trustedCacheRoot?: string,
  ): Promise<CatalogIcon> {
    try {
      if (this.closed) return fail("ICON_CLOSED", "Icon loader is closed.");
      const sources = catalogIconSources(snapshot, key, trustedCacheRoot);
      if (!sources.length)
        return {
          status: "missing",
          message: "No original icon reported by Core.",
        };
      const { refresh, ...identity } = key;
      const id = JSON.stringify([identity, sources]);
      if (refresh) this.entries.delete(id);
      const cached = this.entries.get(id);
      if (
        cached &&
        Date.now() - cached.at <
          (cached.result.status === "ready" ? 300000 : 1000)
      ) {
        this.entries.delete(id);
        this.entries.set(id, cached);
        return cached.result;
      }
      if (this.pending.has(id)) return this.pending.get(id)!;
      if (this.pending.size >= 64)
        return fail("ICON_BUSY", "Icon queue is full; retry this icon.");
      const controller = new AbortController();
      this.controllers.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(this.deadlineMs),
      ]);
      const operation = this.load(sources, signal)
        .then((result) => {
          if (!controller.signal.aborted && !this.closed) {
            this.entries.set(id, {
              at: Date.now(),
              result,
              bytes: result.status === "ready" ? result.dataUrl.length : 256,
            });
            let size = [...this.entries.values()].reduce(
              (n, e) => n + e.bytes,
              0,
            );
            while (size > MAX_CACHE || this.entries.size > 128) {
              const first = this.entries.keys().next().value!;
              size -= this.entries.get(first)!.bytes;
              this.entries.delete(first);
            }
          }
          return result;
        })
        .finally(() => {
          this.pending.delete(id);
          this.controllers.delete(controller);
        });
      this.pending.set(id, operation);
      return operation;
    } catch (e) {
      return this.error(e);
    }
  }
  private error(e: unknown): CatalogIcon {
    return {
      status: "unavailable",
      code: e instanceof IconError ? e.code : "ICON_LOAD_FAILED",
      message:
        e instanceof IconError
          ? e.message
          : "Original icon could not be loaded. Check connectivity and retry.",
    };
  }
  private async load(
    sources: Source[],
    signal: AbortSignal,
  ): Promise<CatalogIcon> {
    let acquired = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.queue = this.queue.filter((f) => f !== start);
          reject(signal.reason);
        };
        const start = () => {
          signal.removeEventListener("abort", abort);
          this.active++;
          acquired = true;
          resolve();
        };
        if (signal.aborted) return reject(signal.reason);
        if (this.active < 4) start();
        else {
          this.queue.push(start);
          signal.addEventListener("abort", abort, { once: true });
        }
      });
      let last: unknown;
      for (const s of sources) {
        signal.throwIfAborted();
        try {
          const body =
            s.kind === "local"
              ? await readLocalIcon(s.root, s.path, signal)
              : await this.remote(s.url, signal);
          signal.throwIfAborted();
          return {
            status: "ready",
            ...iconImage(body),
            source: s.kind,
            field: s.field,
          };
        } catch (e) {
          last = e;
        }
      }
      return this.error(last);
    } catch (e) {
      return this.error(e);
    } finally {
      if (acquired) {
        this.active--;
        this.queue.shift()?.();
      }
    }
  }
  clear() {
    for (const c of this.controllers) c.abort();
    this.entries.clear();
  }
  async dispose() {
    this.closed = true;
    this.clear();
    await Promise.allSettled([...this.pending.values()]);
  }
}
