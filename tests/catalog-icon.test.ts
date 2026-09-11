import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogIcons,
  catalogIconSources,
  iconImage,
  iconUrl,
  isPublicIconAddress,
  readLocalIcon,
  readRemoteIcon,
} from "../src/engine/catalog-icon";
import { catalogIconRequestSchema } from "../src/shared/catalog-icon";
import type { CoreCatalogSnapshot } from "../src/shared/core-catalog";
import type { CatalogIconRequest } from "../src/shared/catalog-icon";
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path fill="blue" d="M0 0h48v48H0z"/></svg>',
);
const key: CatalogIconRequest = {
  catalogId: "original-catalog",
  kind: "app",
  id: "connector",
  theme: "dark",
};
function snapshot(): CoreCatalogSnapshot {
  return {
    id: key.catalogId,
    providerId: "provider",
    workspaceId: "workspace",
    remote: false,
    scope: "provider-configuration",
    startedAt: 1,
    busy: false,
    cancelled: false,
    plugins: {
      marketplaces: [
        {
          name: "original",
          path: "/root/marketplace.json",
          interface: null,
          plugins: [
            {
              id: "original@original",
              source: { type: "local", path: "/root/plugin" },
              interface: {
                logo: "/root/plugin/light.svg",
                logoDark: "/root/plugin/dark.svg",
                composerIcon: null,
                logoUrl: "https://example.com/light.png",
                logoUrlDark: "https://example.com/dark.png",
                composerIconUrl: null,
              },
            } as any,
          ],
        },
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    },
    apps: {
      nextCursor: null,
      data: [
        {
          id: "connector",
          logoUrl: "https://example.com/logo.png",
          logoUrlDark: null,
          iconDarkAssets: {
            "256_square": "https://example.com/original-dark.png",
          },
          iconAssets: { "256_square": "https://example.com/original.png" },
        } as any,
      ],
    },
    installedApps: {
      apps: [
        {
          id: "runtime-only",
          runtimeName: "Original runtime",
          enabled: true,
          callable: true,
        },
      ],
    },
    errors: [],
  };
}
test("Icon boundary accepts only exact original catalog IDs; no renderer URLs, paths, themes or ambiguous identities", () => {
  assert.equal(
    catalogIconRequestSchema.safeParse({ ...key, url: "file:///etc/passwd" })
      .success,
    false,
  );
  assert.equal(
    catalogIconRequestSchema.safeParse({ ...key, theme: "invented" }).success,
    false,
  );
  const s = snapshot();
  assert.throws(
    () => catalogIconSources(s, { ...key, catalogId: "old" }),
    /current Core/,
  );
  assert.throws(
    () => catalogIconSources({ ...s, busy: true }, key),
    /current Core/,
  );
  assert.throws(
    () => catalogIconSources({ ...s, cancelled: true }, key),
    /current Core/,
  );
  assert.throws(
    () => catalogIconSources(s, { ...key, id: "missing" }),
    /identity/,
  );
  assert.throws(
    () => catalogIconSources(s, { ...key, marketplace: "wrong" }),
    /marketplace/,
  );
  s.apps!.data.push(s.apps!.data[0]);
  assert.throws(() => catalogIconSources(s, key), /ambiguous/);
});
test("Original dark/light/composer/connector assets retain order and identity; runtime-only is not invented branding", () => {
  const s = snapshot();
  const plugin = {
    ...key,
    kind: "plugin" as const,
    id: "original@original",
    marketplace: "original",
  };
  assert.deepEqual(
    catalogIconSources(s, plugin).map((s) => s.field),
    ["logoDark", "logoUrlDark", "logo", "logoUrl"],
  );
  assert.equal(
    catalogIconSources(s, { ...plugin, theme: "light" })[0].field,
    "logo",
  );
  assert.deepEqual(
    catalogIconSources(s, key).map((s) => s.field),
    ["iconDarkAssets.256_square", "iconAssets.256_square", "logoUrl"],
  );
  assert.equal(
    catalogIconSources(s, { ...key, theme: "light" })[0].field,
    "iconAssets.256_square",
  );
  assert.deepEqual(catalogIconSources(s, { ...key, id: "runtime-only" }), []);
  assert.throws(
    () => catalogIconSources(s, { ...plugin, marketplace: "other" }),
    /identity/,
  );
  s.plugins!.marketplaces[0].plugins[0].source = { type: "remote" };
  assert.deepEqual(
    catalogIconSources(s, plugin).map((s) => s.kind),
    ["https", "https"],
  );
});
test("Local icon descriptor remains inside original plugin root; traversal, linked escape, oversized and nonimage rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "synora-icon-test-")),
    plugin = join(root, "plugin");
  await mkdir(plugin);
  try {
    const path = join(plugin, "original.svg"),
      outside = join(root, "outside.svg");
    await writeFile(path, svg);
    await writeFile(outside, svg);
    assert.deepEqual(
      await readLocalIcon(plugin, path, AbortSignal.timeout(1000)),
      svg,
    );
    await assert.rejects(
      readLocalIcon(plugin, outside, AbortSignal.timeout(1000)),
      /outside/,
    );
    await symlink(outside, join(plugin, "escaped.svg"));
    await assert.rejects(
      readLocalIcon(
        plugin,
        join(plugin, "escaped.svg"),
        AbortSignal.timeout(1000),
      ),
      /outside/,
    );
    await writeFile(path, Buffer.alloc(512 * 1024 + 1));
    await assert.rejects(
      readLocalIcon(plugin, path, AbortSignal.timeout(1000)),
      /bounded regular/,
    );
    await assert.rejects(
      readLocalIcon(plugin, plugin, AbortSignal.timeout(1000)),
      /outside/,
    );
    assert.throws(
      () => iconImage(Buffer.from("PRIVATE FILE CONTENT")),
      /passive image/,
    );
    const c = new AbortController();
    c.abort();
    await assert.rejects(readLocalIcon(plugin, path, c.signal));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Remote icons reject credentials, HTTP, file URLs, private/mapped/reserved addresses; public IPv4/IPv6 stay allowed", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.23.45.10",
    "192.168.1.1",
    "172.16.1.1",
    "100.64.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.1.1.1",
    "198.18.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:a00:1::1",
    "3fff::1",
  ])
    assert.equal(isPublicIconAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicIconAddress(ip), true, ip);
  for (const url of [
    "file:///etc/passwd",
    "http://example.com/a.png",
    "https://u:p@example.com/a.png",
    "https://example.com:444/a",
    "https://127.0.0.1/a",
    "https://[::ffff:127.0.0.1]/a",
    "data:image/png;base64,AAA",
  ])
    assert.throws(() => iconUrl(url));
  assert.equal(
    iconUrl("https://example.com/a.svg?original=signed").search,
    "?original=signed",
  );
  await assert.rejects(
    readRemoteIcon("https://localhost/a.png", AbortSignal.timeout(1000)),
    /public addresses/,
  );
});
test("Passive image bytes are preserved/hashable, script/doctype/HTML and oversized input cannot become HTML", () => {
  const image = iconImage(svg);
  assert.deepEqual(Buffer.from(image.dataUrl.split(",")[1], "base64"), svg);
  assert.equal(image.sha256.length, 64);
  for (const body of [
    "<html>bad</html>",
    '<svg onload="alert(1)"/>',
    "<svg><script>bad()</script></svg>",
    '<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg/>',
    "<svg><foreignObject/></svg>",
  ])
    assert.throws(() => iconImage(Buffer.from(body)), /passive image/);
  assert.throws(() => iconImage(Buffer.alloc(512 * 1024 + 1)), /limit/);
  assert.throws(
    () => iconImage(Buffer.from('<svg width="9999999" height="9999999"/>')),
    /dimensions/,
  );
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(48, 16);
  png.writeUInt32BE(48, 20);
  assert.ok(iconImage(png).dataUrl.startsWith("data:image/png;"));
  png.writeUInt32BE(4096, 16);
  png.writeUInt32BE(4096, 20);
  assert.throws(() => iconImage(png), /dimensions/);
  const jpeg = Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 48, 0, 48, 1, 1, 17, 0,
  ]);
  assert.ok(iconImage(jpeg).dataUrl.startsWith("data:image/jpeg;"));
  jpeg.writeUInt16BE(65000, 9);
  assert.throws(() => iconImage(jpeg), /dimensions/);
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp.writeUIntLE(47, 24, 3);
  webp.writeUIntLE(47, 27, 3);
  assert.ok(iconImage(webp).dataUrl.startsWith("data:image/webp;"));
  webp.writeUIntLE(100000, 24, 3);
  assert.throws(() => iconImage(webp), /dimensions/);
});
test("Original URL fallback, hash cache, exact stale identity and missing icon semantics", async () => {
  const calls: string[] = [],
    icons = new CatalogIcons(async (url) => {
      calls.push(url);
      if (url.includes("dark")) throw Error("SECRET NETWORK DETAIL");
      return svg;
    });
  try {
    const s = snapshot(),
      result = await icons.read(s, key);
    assert.equal(result.status, "ready");
    if (result.status === "ready")
      assert.equal(result.field, "iconAssets.256_square");
    assert.deepEqual(calls, [
      "https://example.com/original-dark.png",
      "https://example.com/original.png",
    ]);
    assert.deepEqual(await icons.read(s, key), result);
    assert.equal(calls.length, 2);
    assert.equal(
      (await icons.read(s, { ...key, refresh: true })).status,
      "ready",
    );
    assert.equal(calls.length, 4);
    assert.equal((await icons.read(null, key)).status, "unavailable");
    assert.equal(
      (await icons.read(s, { ...key, id: "runtime-only" })).status,
      "missing",
    );
    s.id = "new-catalog";
    assert.equal((await icons.read(s, key)).status, "unavailable");
    const next = await icons.read(s, { ...key, catalogId: s.id });
    assert.equal(next.status, "ready");
    assert.equal(calls.length, 6);
  } finally {
    await icons.dispose();
  }
});

test("Installed git/npm/local icons resolve only inside their exact host-owned Core cache package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-icon-cache-"));
  const cache = join(dir, "plugins", "cache"),
    root = join(cache, "original", "original", "1.0.0");
  await mkdir(root, { recursive: true });
  const path = join(root, "icon.svg");
  await writeFile(path, svg);
  const s = snapshot(),
    p = s.plugins!.marketplaces[0].plugins[0];
  p.name = "original";
  p.installed = true;
  p.interface!.logoDark = path;
  p.interface!.logo = null;
  p.interface!.logoUrlDark = null;
  p.interface!.logoUrl = null;
  const request: CatalogIconRequest = {
    ...key,
    kind: "plugin",
    id: p.id,
    marketplace: "original",
  };
  const loader = new CatalogIcons();
  try {
    for (const source of [
      { type: "local", path: "/original-unpacked-source" },
      {
        type: "git",
        url: "https://example.com/plugin.git",
        path: null,
        refName: null,
        sha: null,
      },
      { type: "npm", package: "original", version: null, registry: null },
    ] as const) {
      p.source = source;
      const result = await loader.read(s, { ...request, refresh: true }, cache);
      assert.equal(result.status, "ready");
      if (result.status === "ready")
        assert.equal(result.sha256, iconImage(svg).sha256);
    }
    p.source = { type: "local", path: "/unrelated" };
    assert.equal(
      (
        await loader.read(
          s,
          { ...request, refresh: true },
          join(dir, "other-provider"),
        )
      ).status,
      "unavailable",
    );
    p.name = "../original";
    assert.equal(
      (await loader.read(s, { ...request, refresh: true }, cache)).status,
      "unavailable",
    );
  } finally {
    await loader.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test("Icons deduplicate in-flight loads, limit concurrency, cancel queue and active work on disposal", async () => {
  let active = 0,
    max = 0,
    calls = 0;
  const icons = new CatalogIcons(async (_url, signal) => {
    calls++;
    active++;
    max = Math.max(max, active);
    try {
      return await new Promise<Buffer>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    } finally {
      active--;
    }
  });
  const s = snapshot();
  const same = [icons.read(s, key), icons.read(s, key)];
  const pending = Array.from({ length: 10 }, (_, i) =>
    icons.read({ ...s, id: `c-${i}` }, { ...key, catalogId: `c-${i}` }),
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(max, 4);
  assert.equal(calls, 4);
  await icons.dispose();
  assert.equal(active, 0);
  for (const r of await Promise.all([...same, ...pending]))
    assert.equal(r.status, "unavailable");
  assert.equal((await icons.read(s, key)).status, "unavailable");
});
test("Icon deadline is bounded, errors do not expose remote details, and clear permits fresh work", async () => {
  let fail = true;
  const icons = new CatalogIcons(async (_url, signal) => {
    if (!fail) return svg;
    return new Promise<Buffer>((_r, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new Error("SECRET-ICON-DETAIL")),
        { once: true },
      ),
    );
  }, 40);
  // A timeout signal is intentionally unref'ed; keep this test runner alive until it is exercised.
  const keeper = setInterval(() => {}, 100);
  try {
    const start = Date.now(),
      result = await icons.read(snapshot(), key);
    assert.equal(result.status, "unavailable");
    assert.ok(Date.now() - start < 1000);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    fail = false;
    icons.clear();
    assert.equal((await icons.read(snapshot(), key)).status, "ready");
  } finally {
    clearInterval(keeper);
    await icons.dispose();
  }
});
