import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rm,
  symlink,
  stat,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import {
  PluginDirectory,
  buildPluginDirectorySnapshot,
  type PluginDirectorySourceFile,
} from "../src/main/plugin-directory";
import {
  PLUGIN_DIRECTORY_SOURCE_URL,
  PLUGIN_DIRECTORY_MARKETPLACE_PATH,
  PLUGIN_DIRECTORY_SEED_REVISION,
  PLUGIN_DIRECTORY_MAX_CACHE_BYTES,
  pluginDirectorySnapshotSchema,
  type PluginDirectorySnapshot,
} from "../src/shared/plugin-directory";
import seed from "../src/shared/plugin-directory-seed.json";
import { iconImage } from "../src/engine/catalog-icon";
import { generatePluginDirectorySeed } from "../scripts/generate-plugin-directory";

const API = "https://api.github.com/repos/openai/plugins";
const RAW = "https://raw.githubusercontent.com/openai/plugins";
const REVISION = "b".repeat(40),
  TREE = "c".repeat(40),
  NOW = 1_800_000_000_000;
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 0h32v32H0z"/></svg>',
);
const blobHash = (b: Buffer) =>
  createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const offline: typeof fetch = async () => {
  throw Error("OFFLINE TEST: no live fetch is permitted");
};

async function temporary(run: (root: string, cache: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "synora-plugin-directory-test-"));
  try {
    await run(root, join(root, "cache", "directory.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fixture(count = 7, revision = REVISION) {
  const files = new Map<string, Buffer>();
  const names = seed.entries.slice(0, count).map((e) => e.name);
  const marketplace = {
    name: "openai-curated",
    plugins: names.map((name) => ({
      name,
      source: { source: "local", path: `./plugins/${name}` },
      category: "Productivity",
    })),
  };
  files.set(PLUGIN_DIRECTORY_MARKETPLACE_PATH, bytes(marketplace));
  for (const [i, name] of names.entries()) {
    files.set(
      `plugins/${name}/.codex-plugin/plugin.json`,
      bytes({
        name,
        description: "Controlled public display metadata",
        version: "1.0.0",
        license: "MIT",
        ...(i === 0 ? { apps: "./.app.json" } : {}),
        interface: {
          displayName: name,
          logo: "./assets/original.svg",
          defaultPrompt: ["NEVER_BUNDLE_INSTRUCTIONS"],
        },
        skills: "./skills",
        hooks: { command: "NEVER_EXECUTE" },
        mcpServers: "./.mcp.json",
      }),
    );
    files.set(`plugins/${name}/assets/original.svg`, svg);
    files.set(`plugins/${name}/.mcp.json`, Buffer.from("NEVER_READ_MCP"));
    files.set(
      `plugins/${name}/skills/demo/SKILL.md`,
      Buffer.from("NEVER_READ_SKILL"),
    );
  }
  files.set(
    `plugins/${names[0]}/.app.json`,
    Buffer.from("NEVER_READ_GRANT_OR_APP_CONFIGURATION"),
  );
  files.set(
    `plugins/${names[0]}/LICENSE`,
    Buffer.from("Original controlled license notice.\n"),
  );
  const tree = () => ({
    sha: TREE,
    truncated: false,
    tree: [...files].map(([path, data]) => ({
      path,
      mode: "100644",
      type: "blob",
      size: data.length,
      sha: blobHash(data),
    })),
  });
  const requests: { url: string; init: RequestInit }[] = [];
  let active = 0,
    peak = 0;
  let override:
    | ((
        url: string,
        init: RequestInit,
      ) => Promise<Response> | Response | undefined)
    | undefined;
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    active++;
    peak = Math.max(peak, active);
    try {
      await tick();
      const custom = override?.(url, init);
      if (custom) return await custom;
      if (url === `${API}/git/ref/heads/main`)
        return new Response(
          bytes({
            ref: "refs/heads/main",
            object: { type: "commit", sha: revision },
          }),
        );
      if (url === `${API}/git/commits/${revision}`)
        return new Response(bytes({ sha: revision, tree: { sha: TREE } }));
      if (url === `${API}/git/trees/${TREE}?recursive=1`)
        return new Response(bytes(tree()));
      if (!url.startsWith(`${RAW}/${revision}/`))
        throw Error("Unexpected URL in offline fixture");
      const path = url.slice(`${RAW}/${revision}/`.length);
      if (/\.app\.json$|\.mcp\.json$|SKILL\.md$/.test(path))
        throw Error("Executable/account metadata must never be read");
      const data = files.get(path);
      assert.ok(data, `Unexpected source file: ${path}`);
      return new Response(new Uint8Array(data));
    } finally {
      active--;
    }
  };
  return {
    files,
    names,
    marketplace,
    requests,
    tree,
    transport,
    revision,
    get peak() {
      return peak;
    },
    setOverride(fn: typeof override) {
      override = fn;
    },
    manifest(index: number, change: (manifest: any) => void) {
      const path = `plugins/${names[index]}/.codex-plugin/plugin.json`;
      const manifest = JSON.parse(files.get(path)!.toString());
      change(manifest);
      files.set(path, bytes(manifest));
    },
  };
}

test("offline seed always contains all 65 official entries, original Gmail bytes and honest metadata only", async () => {
  await temporary(async (_root, cache) => {
    let calls = 0;
    const directory = new PluginDirectory(cache, {
      fetch: async () => {
        calls++;
        return offline("");
      },
    });
    const snapshot = await directory.read();
    assert.equal(snapshot.entries.length, 65);
    assert.equal(snapshot.revision, PLUGIN_DIRECTORY_SEED_REVISION);
    assert.equal(snapshot.sourceUrl, PLUGIN_DIRECTORY_SOURCE_URL);
    assert.equal(snapshot.checking, false);
    assert.equal(snapshot.error, null);
    assert.equal(calls, 0);
    assert.equal(snapshot.entries.filter((e) => e.icon).length, 58);
    assert.equal(
      snapshot.entries.find((e) => e.name === "gmail")!.icon!.sha256,
      "94b90b1c5fca7defb96588f4d7032af87f9514c895cc9f2f3846d829ca9c7cba",
    );
    assert.deepEqual(
      snapshot.entries.filter((e) => !e.icon).map((e) => e.name),
      [
        "adobe",
        "lovable",
        "consensus",
        "higgsfield",
        "crowdstrike-falcon-foundry",
        "crowdstrike-falcon-fusion",
        "qodo",
      ],
    );
    for (const entry of snapshot.entries) {
      assert.equal(entry.id, `${entry.name}@openai-curated`);
      if (entry.icon)
        assert.deepEqual(
          iconImage(Buffer.from(entry.icon.dataUrl.split(",")[1], "base64")),
          entry.icon,
        );
      else assert.ok(entry.iconError);
      for (const key of [
        "installed",
        "callable",
        "enabled",
        "tools",
        "skills",
        "hooks",
        "defaultPrompt",
        "apps",
        "mcpServers",
      ])
        assert.equal(key in entry, false);
    }
    assert.equal("automatic" in snapshot, false);
    assert.equal(
      snapshot.entries.find((e) => e.name === "gmail")!.requiresAccount,
      true,
    );
    assert.equal(
      snapshot.entries.find((e) => e.name === "qodo")!.accountRequirementKnown,
      false,
    );
    assert.equal(
      snapshot.entries.find((e) => e.name === "superpowers")!.iconSourceField,
      "composerIcon",
    );
    assert.match(
      snapshot.entries.find((e) => e.name === "superpowers")!.iconError!,
      /ICON_DIMENSIONS/,
    );
    assert.match(snapshot.repositoryLicenseNote!, /No root license/);
    assert.equal(
      snapshot.entries.find((e) => e.name === "figma")!.license,
      "LicenseRef-Figma-Developer-Terms",
    );
    assert.ok(
      snapshot.entries.find((e) => e.name === "figma")!.licenseFiles?.[0].text,
    );
    snapshot.entries.length = 0;
    assert.equal(
      (await directory.read()).entries.length,
      65,
      "caller mutation cannot erase backend seed",
    );
    await assert.rejects(stat(cache), { code: "ENOENT" });
    await directory.dispose();
  });
});

test("offline generator requires the pinned checkout and copies only metadata and original icons", async () => {
  // Hermetic on Mac/source transfers too: actual upstream reproduction is verified
  // separately by generate-plugin-directory.ts <actual-checkout> --check.
  await temporary(async (root) => {
    const f = fixture(2);
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, ".git", "HEAD"),
      PLUGIN_DIRECTORY_SEED_REVISION + "\n",
    );
    for (const [path, data] of f.files) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), data, { mode: 0o644 });
    }
    const generated = await generatePluginDirectorySeed(root, NOW);
    assert.equal(generated.entries.length, 2);
    assert.equal(generated.revision, PLUGIN_DIRECTORY_SEED_REVISION);
    assert.equal(JSON.stringify(generated).includes("NEVER_"), false);
    for (const entry of generated.entries) {
      assert.deepEqual(
        iconImage(await readFile(join(root, entry.iconPath!))),
        entry.icon,
      );
    }
    await writeFile(join(root, ".git", "HEAD"), REVISION + "\n");
    await assert.rejects(
      generatePluginDirectorySeed(root, NOW),
      /pinned seed revision/,
    );
  });
});

test("refresh is commit pinned, four-wide, credential-free, metadata-only, atomic and cold-cache readable", async () => {
  await temporary(async (_root, cache) => {
    const f = fixture();
    const directory = new PluginDirectory(cache, {
      fetch: f.transport,
      now: () => NOW,
    });
    const first = directory.refresh(),
      duplicate = directory.refresh();
    assert.equal(first, duplicate);
    const checking = await directory.read();
    assert.equal(checking.checking, true);
    assert.equal(checking.entries.length, 65);
    const snapshot = await first;
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.checking, false);
    assert.equal(snapshot.revision, REVISION);
    assert.equal(snapshot.fetchedAt, NOW);
    assert.equal(snapshot.entries.length, 7);
    assert.equal(f.peak, 4);
    assert.equal(new Set(f.requests.map((r) => r.url)).size, f.requests.length);
    for (const { url, init } of f.requests) {
      assert.ok(
        url.startsWith(API + "/git/") || url.startsWith(`${RAW}/${REVISION}/`),
      );
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "GET");
      assert.equal(init.referrerPolicy, "no-referrer");
      const headers = new Headers(init.headers);
      for (const key of [
        "authorization",
        "cookie",
        "proxy-authorization",
        "referer",
      ])
        assert.equal(headers.has(key), false);
    }
    assert.equal(snapshot.entries[0].requiresAccount, true);
    assert.equal(snapshot.entries[1].requiresAccount, false);
    assert.equal(JSON.stringify(snapshot).includes("NEVER_"), false);
    assert.equal(
      JSON.stringify(JSON.parse(await readFile(cache, "utf8")).snapshot),
      JSON.stringify(snapshot),
    );
    assert.deepEqual(await readdir(join(cache, "..")), ["directory.json"]);
    if (process.platform !== "win32")
      assert.equal((await stat(cache)).mode & 0o777, 0o600);
    const restored = new PluginDirectory(cache, { fetch: offline });
    assert.deepEqual(await restored.read(), snapshot);
    const failed = await restored.refresh();
    assert.ok(failed.error);
    assert.equal(failed.checking, false);
    assert.deepEqual(failed.entries, snapshot.entries);
    assert.equal(failed.fetchedAt, NOW);
    assert.equal(
      JSON.parse(await readFile(cache, "utf8")).snapshot.error,
      null,
    );
    await restored.dispose();
    await directory.dispose();
  });
});

test("slow refresh leaves read immediately available with previous data and checking=true", async () => {
  await temporary(async (_root, cache) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture(1);
    f.setOverride((url) =>
      url.endsWith("/git/ref/heads/main")
        ? gate.then(
            () =>
              new Response(
                bytes({
                  ref: "refs/heads/main",
                  object: { type: "commit", sha: REVISION },
                }),
              ),
          )
        : undefined,
    );
    const directory = new PluginDirectory(cache, { fetch: f.transport });
    const pending = directory.refresh();
    const snapshot = await directory.read();
    assert.equal(snapshot.checking, true);
    assert.equal(snapshot.entries.length, 65);
    release();
    assert.equal((await pending).error, null);
    await directory.dispose();
  });
});

test("unchanged official HEAD reuses the verified seed with one ref GET and persists a fresh timestamp", async () => {
  await temporary(async (_root, cache) => {
    const requests: string[] = [];
    const directory = new PluginDirectory(cache, {
      now: () => NOW,
      fetch: async (input) => {
        requests.push(String(input));
        assert.equal(String(input), `${API}/git/ref/heads/main`);
        return new Response(
          bytes({
            ref: "refs/heads/main",
            object: { type: "commit", sha: PLUGIN_DIRECTORY_SEED_REVISION },
          }),
        );
      },
    });
    const snapshot = await directory.refresh();
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.fetchedAt, NOW);
    assert.equal(snapshot.checking, false);
    assert.deepEqual(snapshot.entries, seed.entries);
    assert.deepEqual(requests, [`${API}/git/ref/heads/main`]);
    const cold = new PluginDirectory(cache, { fetch: offline });
    assert.deepEqual(await cold.read(), snapshot);
    await cold.dispose();
    await directory.dispose();
  });
});

test("unchanged cached HEAD only rechecks the ref; changed HEAD still fetches the complete pinned directory", async () => {
  await temporary(async (_root, cache) => {
    const f = fixture(2);
    const first = new PluginDirectory(cache, {
      fetch: f.transport,
      now: () => NOW,
    });
    assert.equal((await first.refresh()).error, null);
    await first.dispose();
    f.requests.length = 0;
    const cold = new PluginDirectory(cache, {
      fetch: f.transport,
      now: () => NOW + 10_000,
    });
    const same = await cold.refresh();
    assert.equal(same.error, null);
    assert.equal(same.fetchedAt, NOW + 10_000);
    assert.deepEqual(
      f.requests.map((r) => r.url),
      [`${API}/git/ref/heads/main`],
    );
    await cold.dispose();
    const changed = fixture(3, "e".repeat(40));
    const newer = new PluginDirectory(cache, {
      fetch: changed.transport,
      now: () => NOW + 20_000,
    });
    const updated = await newer.refresh();
    assert.equal(updated.error, null);
    assert.equal(updated.revision, changed.revision);
    assert.equal(updated.entries.length, 3);
    assert.ok(
      changed.requests.some(
        (r) => r.url === `${API}/git/commits/${changed.revision}`,
      ),
    );
    for (const name of changed.names)
      assert.ok(
        changed.requests.some(
          (r) =>
            r.url ===
            `${RAW}/${changed.revision}/plugins/${name}/.codex-plugin/plugin.json`,
        ),
      );
    await newer.dispose();
  });
});

test("malformed and unsafe refreshes preserve the exact previous cache and complete snapshot", async (t) => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    [
      "malformed JSON",
      (f) => f.files.set(PLUGIN_DIRECTORY_MARKETPLACE_PATH, Buffer.from("{")),
    ],
    [
      "manifest identity mismatch",
      (f) =>
        f.manifest(0, (m) => {
          m.name = "wrong";
        }),
    ],
    [
      "oversized plain field",
      (f) =>
        f.manifest(0, (m) => {
          m.description = "x".repeat(17 * 1024);
        }),
    ],
    [
      "duplicate marketplace entry",
      (f) => {
        f.marketplace.plugins.push(f.marketplace.plugins[0]);
        f.files.set(PLUGIN_DIRECTORY_MARKETPLACE_PATH, bytes(f.marketplace));
      },
    ],
    [
      "empty marketplace",
      (f) =>
        f.files.set(
          PLUGIN_DIRECTORY_MARKETPLACE_PATH,
          bytes({ name: "openai-curated", plugins: [] }),
        ),
    ],
    [
      "entry count limit",
      (f) =>
        f.files.set(
          PLUGIN_DIRECTORY_MARKETPLACE_PATH,
          bytes({
            name: "openai-curated",
            plugins: Array(257).fill(f.marketplace.plugins[0]),
          }),
        ),
    ],
    [
      "source traversal",
      (f) => {
        f.marketplace.plugins[0].source.path = "./plugins/../private";
        f.files.set(PLUGIN_DIRECTORY_MARKETPLACE_PATH, bytes(f.marketplace));
      },
    ],
    ...[
      "../private.png",
      "./assets/../../private.png",
      "./assets/%2e%2e/logo.png",
      "./assets\\logo.png",
      "/etc/private.png",
      "https://evil.example/logo.png",
    ].map((path): [string, (f: ReturnType<typeof fixture>) => void] => [
      `icon path ${path}`,
      (f) =>
        f.manifest(0, (m) => {
          m.interface.logo = path;
        }),
    ]),
    [
      "invalid passive image",
      (f) =>
        f.files.set(
          `plugins/${f.names[0]}/assets/original.svg`,
          Buffer.from('<svg onload="evil()"/>'),
        ),
    ],
    [
      "oversized image",
      (f) =>
        f.files.set(
          `plugins/${f.names[0]}/assets/original.svg`,
          Buffer.alloc(512 * 1024 + 1),
        ),
    ],
    [
      "missing manifest",
      (f) => {
        f.files.delete(`plugins/${f.names[0]}/.codex-plugin/plugin.json`);
      },
    ],
    [
      "missing selected icon",
      (f) => {
        f.files.delete(`plugins/${f.names[0]}/assets/original.svg`);
      },
    ],
    [
      "source license oversized",
      (f) =>
        f.files.set(
          `plugins/${f.names[0]}/LICENSE`,
          Buffer.alloc(64 * 1024 + 1),
        ),
    ],
    [
      "unsupported app path",
      (f) =>
        f.manifest(0, (m) => {
          m.apps = "../../private.json";
        }),
    ],
    [
      "truncated Git tree",
      (f) =>
        f.setOverride((url) =>
          url.includes("/git/trees/")
            ? new Response(bytes({ ...f.tree(), truncated: true }))
            : undefined,
        ),
    ],
    [
      "wrong tree SHA",
      (f) =>
        f.setOverride((url) =>
          url.includes("/git/trees/")
            ? new Response(bytes({ ...f.tree(), sha: "d".repeat(40) }))
            : undefined,
        ),
    ],
    [
      "wrong commit SHA",
      (f) =>
        f.setOverride((url) =>
          url.includes("/git/commits/")
            ? new Response(bytes({ sha: "d".repeat(40), tree: { sha: TREE } }))
            : undefined,
        ),
    ],
    [
      "blob mismatch",
      (f) =>
        f.setOverride((url) =>
          url.endsWith("/LICENSE")
            ? new Response("not the pinned source")
            : undefined,
        ),
    ],
    [
      "tree traversal",
      (f) =>
        f.setOverride((url) =>
          url.includes("/git/trees/")
            ? new Response(
                bytes({
                  ...f.tree(),
                  tree: [
                    ...f.tree().tree,
                    {
                      path: "../private",
                      type: "blob",
                      mode: "100644",
                      sha: TREE,
                      size: 1,
                    },
                  ],
                }),
              )
            : undefined,
        ),
    ],
    ...["120000", "100755", "160000"].map(
      (mode): [string, (f: ReturnType<typeof fixture>) => void] => [
        `unsafe selected tree mode ${mode}`,
        (f) =>
          f.setOverride((url) => {
            if (!url.includes("/git/trees/")) return;
            const tree = f.tree();
            tree.tree.find((n) =>
              n.path.endsWith("assets/original.svg"),
            )!.mode = mode;
            return new Response(bytes(tree));
          }),
      ],
    ),
    [
      "network failure",
      (f) =>
        f.setOverride(() => {
          throw Error("UNTRUSTED_NETWORK_ERROR_WITH_SECRET");
        }),
    ],
    [
      "HTTP redirect",
      (f) =>
        f.setOverride(
          () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example" },
            }),
        ),
    ],
    [
      "followed redirect",
      (f) =>
        f.setOverride(() => {
          const r = new Response("{}");
          Object.defineProperty(r, "redirected", { value: true });
          return r;
        }),
    ],
    [
      "unexpected response URL",
      (f) =>
        f.setOverride(() => {
          const r = new Response("{}");
          Object.defineProperty(r, "url", { value: "https://evil.example" });
          return r;
        }),
    ],
    [
      "HTTP authorization required",
      (f) => f.setOverride(() => new Response(null, { status: 401 })),
    ],
    [
      "oversized content-length",
      (f) =>
        f.setOverride(
          () =>
            new Response("{}", { headers: { "content-length": "99999999" } }),
        ),
    ],
    [
      "oversized streamed body",
      (f) => f.setOverride(() => new Response(new Uint8Array(16 * 1024 + 1))),
    ],
    [
      "truncated content-length",
      (f) =>
        f.setOverride(
          () => new Response("{}", { headers: { "content-length": "20" } }),
        ),
    ],
    [
      "unexpected compression",
      (f) =>
        f.setOverride(
          () => new Response("{}", { headers: { "content-encoding": "gzip" } }),
        ),
    ],
  ];
  await temporary(async (_root, cache) => {
    const good = fixture(1);
    const initial = new PluginDirectory(cache, {
      fetch: good.transport,
      now: () => NOW,
    });
    const valid = await initial.refresh();
    assert.equal(valid.error, null);
    const cacheBytes = await readFile(cache);
    await initial.dispose();
    for (const [name, mutate] of cases)
      await t.test(name, async () => {
        const f = fixture(1, "e".repeat(40));
        mutate(f);
        const directory = new PluginDirectory(cache, { fetch: f.transport });
        const failed = await directory.refresh();
        assert.ok(failed.error, name);
        assert.equal(
          failed.error.includes("UNTRUSTED_NETWORK_ERROR_WITH_SECRET"),
          false,
        );
        assert.equal(failed.checking, false);
        assert.equal(failed.revision, valid.revision);
        assert.equal(failed.fetchedAt, valid.fetchedAt);
        assert.deepEqual(failed.entries, valid.entries);
        assert.deepEqual(await readFile(cache), cacheBytes);
        assert.ok(
          f.requests.every(
            (r) =>
              r.url.startsWith(API + "/") ||
              r.url.startsWith(`${RAW}/${f.revision}/`),
          ),
        );
        await directory.dispose();
      });
  });
});

test("missing, malformed, oversized, linked, tampered and nonregular disk caches fall back to seed visibly", async (t) => {
  for (const scenario of [
    "malformed",
    "oversized",
    "symlink",
    "directory",
    "icon hash",
    "icon payload",
    "license hash",
    "unknown action",
    "checking",
    "duplicate",
    "source URL",
  ])
    await t.test(scenario, async () =>
      temporary(async (root, cache) => {
        await mkdir(join(cache, ".."), { recursive: true });
        const snapshot: PluginDirectorySnapshot = structuredClone(
          seed,
        ) as PluginDirectorySnapshot;
        if (scenario === "malformed") await writeFile(cache, "{");
        else if (scenario === "oversized") {
          await writeFile(cache, "");
          await truncate(cache, PLUGIN_DIRECTORY_MAX_CACHE_BYTES + 1);
        } else if (scenario === "symlink") {
          const target = join(root, "outside.json");
          await writeFile(target, "{}");
          await symlink(target, cache);
        } else if (scenario === "directory") await mkdir(cache);
        else {
          if (scenario === "icon hash")
            snapshot.entries[0].icon!.sha256 = "0".repeat(64);
          if (scenario === "icon payload")
            snapshot.entries[0].icon!.dataUrl =
              "data:image/svg+xml;base64," +
              Buffer.from('<svg onload="evil()"/>').toString("base64");
          if (scenario === "license hash")
            snapshot.entries.find(
              (e) => e.licenseFiles?.length,
            )!.licenseFiles![0].sha256 = "0".repeat(64);
          if (scenario === "unknown action")
            (snapshot.entries[0] as any).installed = true;
          if (scenario === "checking") snapshot.checking = true;
          if (scenario === "duplicate")
            snapshot.entries.push(snapshot.entries[0]);
          if (scenario === "source URL")
            snapshot.entries[0].sourceUrl = "https://evil.example/metadata";
          await writeFile(cache, bytes({ version: 1, snapshot }));
        }
        const directory = new PluginDirectory(cache, { fetch: offline });
        const result = await directory.read();
        assert.equal(result.entries.length, 65);
        assert.equal(result.revision, PLUGIN_DIRECTORY_SEED_REVISION);
        assert.equal(result.checking, false);
        assert.match(result.error!, /cache.*invalid or unreadable/);
        assert.deepEqual(result.entries, seed.entries);
        await directory.dispose();
      }),
    );
});

test("fetch and streaming deadlines settle even if the host test transport ignores abort", async (t) => {
  for (const kind of ["fetch", "stream"])
    await t.test(kind, async () =>
      temporary(async (_root, cache) => {
        let cancelled = false;
        const directory = new PluginDirectory(cache, {
          timeout: 40,
          fetch: async () => {
            if (kind === "fetch") return new Promise<Response>(() => {});
            return new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
            );
          },
        });
        const result = await directory.refresh();
        assert.match(result.error!, /deadline/);
        assert.equal(result.entries.length, 65);
        assert.equal(result.checking, false);
        if (kind === "stream") assert.equal(cancelled, true);
        await directory.dispose();
        await assert.rejects(stat(cache), { code: "ENOENT" });
      }),
    );
});

test("dispose cancels in-flight work, dedupes callers, leaves seed and never writes a partial cache", async () => {
  await temporary(async (_root, cache) => {
    let started!: () => void;
    const didStart = new Promise<void>((r) => {
      started = r;
    });
    let signal: AbortSignal | undefined;
    const directory = new PluginDirectory(cache, {
      fetch: async (_input, init) => {
        signal = init!.signal!;
        started();
        return new Promise<Response>(() => {});
      },
    });
    const pending = directory.refresh();
    await didStart;
    assert.equal(directory.refresh(), pending);
    await directory.dispose();
    const result = await pending;
    assert.equal(signal?.aborted, true);
    assert.match(result.error!, /disposed/);
    assert.equal(result.checking, false);
    assert.equal(result.entries.length, 65);
    assert.match((await directory.refresh()).error!, /disposed/);
    await assert.rejects(stat(cache), { code: "ENOENT" });
  });
});

test("cache write failure retains seed and no temporary artifact", async () => {
  await temporary(async (_root, cache) => {
    await mkdir(cache, { recursive: true }); // A directory cannot be replaced by a cache file.
    const f = fixture(1);
    const directory = new PluginDirectory(cache, { fetch: f.transport });
    const result = await directory.refresh();
    assert.ok(result.error);
    assert.equal(result.entries.length, 65);
    assert.deepEqual(await readdir(join(cache, "..")), ["directory.json"]);
    await directory.dispose();
  });
});

test("no URL/configuration arguments or preference fields can expand the metadata-only boundary", async () => {
  await temporary(async (_root, cache) => {
    assert.throws(
      () =>
        new PluginDirectory(cache, {
          sourceUrl: "https://evil.example",
        } as any),
      /host-owned/,
    );
    for (const timeout of [NaN, Infinity, -1, 0])
      assert.throws(() => new PluginDirectory(cache, { timeout }), /timeout/);
    let calls = 0;
    const directory = new PluginDirectory(cache, {
      fetch: async () => {
        calls++;
        return offline("");
      },
    });
    const result = await (directory.refresh as any)("https://evil.example");
    assert.match(result.error, /no arguments/);
    assert.equal(calls, 0);
    assert.equal(
      pluginDirectorySnapshotSchema.safeParse({ ...seed, automatic: true })
        .success,
      false,
    );
    assert.equal(
      pluginDirectorySnapshotSchema.safeParse({ ...seed, install: true })
        .success,
      false,
    );
    await directory.dispose();
  });
});

test("external marketplace entries are retained as declared metadata; their repository is never requested", async () => {
  const marketplace = bytes({
    name: "openai-curated",
    plugins: [
      {
        name: "qodo",
        source: {
          source: "git-subdir",
          url: "https://github.com/qodo-ai/qodo-skills.git",
          path: "codex-packages/qodo",
        },
        category: "Developer Tools",
        interface: { displayName: "Qodo" },
      },
    ],
  });
  const files = new Map<string, PluginDirectorySourceFile>([
    [
      PLUGIN_DIRECTORY_MARKETPLACE_PATH,
      { mode: "100644", size: marketplace.length },
    ],
  ]);
  const reads: string[] = [];
  const snapshot = await buildPluginDirectorySnapshot({
    revision: REVISION,
    fetchedAt: NOW,
    files,
    read: async (path) => {
      reads.push(path);
      assert.equal(path, PLUGIN_DIRECTORY_MARKETPLACE_PATH);
      return marketplace;
    },
  });
  assert.deepEqual(reads, [PLUGIN_DIRECTORY_MARKETPLACE_PATH]);
  assert.equal(snapshot.entries[0].name, "qodo");
  assert.equal(snapshot.entries[0].metadataOrigin, "marketplace");
  assert.equal(snapshot.entries[0].accountRequirementKnown, false);
  assert.equal(snapshot.entries[0].icon, null);
  assert.match(snapshot.entries[0].iconError!, /External manifest/);
});
