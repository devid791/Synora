import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { create, Unpack } from "tar";
import {
  corePackage,
  installCore,
  sha256File,
  verifyCoreArchive,
  verifyCoreInstall,
  type CorePackage,
} from "../src/engine/core-runtime";

function replaceBuiltin<T extends object, K extends keyof T>(
  t: TestContext,
  target: T,
  key: K,
  value: T[K],
) {
  const method = t.mock.method(target, key, value as never);
  syncBuiltinESMExports();
  const restore = () => {
    method.mock.restore();
    syncBuiltinESMExports();
  };
  t.after(restore);
  return restore;
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fsPromises.realpath(
    await mkdtemp(join(tmpdir(), "synora-core-fixture-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    archive = join(root, "fixture.tar.gz"),
    cache = join(root, "cache");
  const spec: CorePackage = { ...corePackage("linux-x64"), files: {} };
  const metadata = {
    layoutVersion: 1,
    version: spec.version,
    target: spec.target,
    variant: "codex",
    entrypoint: "bin/codex",
    resourcesDir: "codex-resources",
    pathDir: "codex-path",
  };
  for (const name of Object.keys(corePackage("linux-x64").files)) {
    const data = Buffer.from(
      name === "codex-package.json"
        ? JSON.stringify(metadata)
        : `fixture ${name}`,
    );
    spec.files[name] = [
      data.length,
      createHash("sha256").update(data).digest("hex"),
    ];
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), data, { mode: 0o700 });
  }
  const repack = async (paths = Object.keys(spec.files)) => {
    await create(
      { file: archive, cwd: source, gzip: true, portable: true },
      paths,
    );
    spec.size = (await readFile(archive)).length;
    spec.sha256 = await sha256File(archive);
  };
  await repack();
  return { root, source, archive, cache, spec, repack };
}
test("owned Core installation preserves all helpers; offline restart and concurrent install", async (t) => {
  const f = await fixture(t);
  const paths = await Promise.all([
    installCore(f.archive, f.cache, f.spec),
    installCore(f.archive, f.cache, f.spec),
  ]);
  assert.equal(paths[0], paths[1]);
  assert.equal((await readdir(f.cache)).length, 1);
  assert.equal(
    await verifyCoreInstall(dirname(dirname(paths[0])), f.spec),
    paths[0],
  );
  await rm(f.archive);
  assert.equal(await installCore(f.archive, f.cache, f.spec), paths[0]);
});
test("archive hash failure never creates an installation", async (t) => {
  const f = await fixture(t);
  await writeFile(f.archive, "corrupted");
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    /integrity mismatch/,
  );
  assert.deepEqual(await readdir(f.cache), []);
});
test("incomplete and duplicate archives are rejected before extraction", async (t) => {
  const f = await fixture(t);
  await f.repack(
    Object.keys(f.spec.files).filter((n) => !n.includes("code-mode")),
  );
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    /missing.*code-mode/,
  );
  await f.repack([...Object.keys(f.spec.files), "bin/codex"]);
  await assert.rejects(verifyCoreArchive(f.archive, f.spec), /duplicate/);
  assert.deepEqual(await readdir(f.cache), []);
});
test("unknown paths and symlink payloads are not rewritten or accepted", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.source, "unexpected"), "extra");
  await f.repack([...Object.keys(f.spec.files), "unexpected"]);
  await assert.rejects(verifyCoreArchive(f.archive, f.spec), /unexpected/);
  // On Windows the junction can be created without Developer Mode elevation.
  await symlink(
    f.source,
    join(f.source, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await f.repack([...Object.keys(f.spec.files), "link"]);
  await assert.rejects(
    verifyCoreArchive(f.archive, f.spec),
    /unexpected entry\/type/,
  );
  await assert.rejects(
    verifyCoreArchive(f.archive, {
      ...f.spec,
      files: { "../escape": [1, "0".repeat(64)] },
    }),
    /Unsafe pinned/,
  );
});
test("tampered or missing cached helpers are rejected and never silently replaced", async (t) => {
  const f = await fixture(t),
    binary = await installCore(f.archive, f.cache, f.spec);
  const helper = join(dirname(binary), "codex-code-mode-host");
  await writeFile(helper, "altered");
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    /integrity mismatch/,
  );
  assert.equal(await readFile(helper, "utf8"), "altered");
  await rm(helper);
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    /Missing Core runtime helper/,
  );
});
test("wrong metadata and unexpected cached payloads fail qualification", async (t) => {
  const f = await fixture(t),
    binary = await installCore(f.archive, f.cache, f.spec),
    root = dirname(dirname(binary));
  await writeFile(join(root, "extra"), "unexpected");
  await assert.rejects(
    verifyCoreInstall(root, f.spec),
    /Unexpected Core runtime payload/,
  );
  await rm(join(root, "extra"));
  await assert.rejects(
    verifyCoreInstall(root, { ...f.spec, target: "different" }),
    /metadata/,
  );
  if (process.platform !== "win32") {
    await chmod(binary, 0o600);
    await assert.rejects(verifyCoreInstall(root, f.spec), /not executable/);
  }
  assert.throws(() => corePackage("linux-armv7"), /No qualified Core package/);
});

test("insufficient expanded-payload space rejects before extraction or staging", async (t) => {
  const f = await fixture(t);
  const volume = await fsPromises.statfs(f.root, { bigint: true });
  let checks = 0;
  replaceBuiltin(t, fsPromises, "statfs", (async (path) => {
    checks++;
    assert.equal(path, await fsPromises.realpath(f.cache));
    return { ...volume, bsize: 4096n, bavail: 0n };
  }) as typeof fsPromises.statfs);
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, "ENOSPC");
      assert.match(error.message, /Insufficient disk space/);
      return true;
    },
  );
  assert.equal(checks, 1);
  assert.deepEqual(await readdir(f.cache), []);
});

test(
  "installed tar write failure drains before cleanup and retains the first error if cleanup fails",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const original = Object.assign(
      new Error("ENOSPC: injected owned extraction open failure"),
      { code: "ENOSPC" },
    );
    const cleanup = Object.assign(
      new Error("ENOTEMPTY: injected owned staging cleanup failure"),
      { code: "ENOTEMPTY" },
    );
    let close!: () => void;
    const drained = new Promise<void>((resolve) => {
      close = resolve;
    });
    let closed = false;
    const emit = Unpack.prototype.emit;
    t.mock.method(
      Unpack.prototype,
      "emit",
      function (this: Unpack, event: string | symbol, ...args: unknown[]) {
        if (event === "close") {
          closed = true;
          close();
        }
        return Reflect.apply(emit, this, [event, ...args]);
      },
    );
    const open = fs.open;
    let injected = false;
    replaceBuiltin(t, fs, "open", ((...args: unknown[]) => {
      const path = normalize(String(args[0]));
      if (
        !injected &&
        path.startsWith(f.cache + sep) &&
        path.endsWith(join("bin", "codex"))
      ) {
        injected = true;
        const callback = args.at(-1) as (error: Error) => void;
        queueMicrotask(() => callback(original));
        return;
      }
      return Reflect.apply(open, fs, args);
    }) as typeof fs.open);
    const remove = fsPromises.rm;
    let cleanedBeforeClose = false;
    let cleanupPath = "";
    replaceBuiltin(t, fsPromises, "rm", (async (path, options) => {
      if (String(path).startsWith(join(f.cache, ".synora-core-"))) {
        cleanupPath = String(path);
        cleanedBeforeClose = !closed;
        throw cleanup;
      }
      return remove(path, options);
    }) as typeof fsPromises.rm);
    const error = await installCore(f.archive, f.cache, f.spec).then(
      () => assert.fail("A failed extraction must not be installed"),
      (error: unknown) => error,
    );
    // Even the red/baseline run waits for tar's actual close before test teardown.
    await drained;
    assert.equal(injected, true);
    assert.equal(cleanedBeforeClose, false);
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, original);
    assert.deepEqual(error.errors, [original, cleanup]);
    assert.match(error.message, /ENOSPC.*ENOTEMPTY/);
    assert.ok(cleanupPath.startsWith(join(f.cache, ".synora-core-")));
    assert.deepEqual(await readdir(f.cache), [
      cleanupPath.slice(f.cache.length + 1),
    ]);
    await assert.rejects(verifyCoreInstall(cleanupPath, f.spec));
  },
);

test("space admission counts allocated expanded files and directories, not compressed bytes", async (t) => {
  const f = await fixture(t);
  const volume = await fsPromises.statfs(f.root, { bigint: true });
  const directories = new Set<string>();
  for (const name of Object.keys(f.spec.files)) {
    const parts = name.split("/");
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join("/"));
    }
  }
  const blocks =
    BigInt(directories.size + 1) +
    Object.values(f.spec.files).reduce(
      (sum, [size]) => sum + (BigInt(size) + 4095n) / 4096n,
      0n,
    );
  let available = blocks - 1n;
  assert.ok(available * 4096n > BigInt(f.spec.size));
  replaceBuiltin(t, fsPromises, "statfs", (async (_path, options) => {
    assert.equal(options?.bigint, true);
    return { ...volume, bsize: 4096n, bavail: available };
  }) as typeof fsPromises.statfs);
  await assert.rejects(installCore(f.archive, f.cache, f.spec), {
    code: "ENOSPC",
  });
  assert.deepEqual(await readdir(f.cache), []);
  available = blocks;
  const binary = await installCore(f.archive, f.cache, f.spec);
  assert.equal(
    await verifyCoreInstall(dirname(dirname(binary)), f.spec),
    binary,
  );
});

test("verified existing cache remains usable offline even when space inspection fails", async (t) => {
  const f = await fixture(t);
  const binary = await installCore(f.archive, f.cache, f.spec);
  await rm(f.archive);
  let checks = 0;
  replaceBuiltin(t, fsPromises, "statfs", (async () => {
    checks++;
    throw Object.assign(new Error("injected unavailable statfs"), {
      code: "EIO",
    });
  }) as typeof fsPromises.statfs);
  assert.equal(await installCore(f.archive, f.cache, f.spec), binary);
  assert.equal(checks, 0);
  assert.equal((await readdir(f.cache)).length, 1);
});

test("space inspection failure is retained before any extraction is created", async (t) => {
  const f = await fixture(t);
  const original = Object.assign(new Error("EIO: injected statfs failure"), {
    code: "EIO",
  });
  replaceBuiltin(t, fsPromises, "statfs", (async () => {
    throw original;
  }) as typeof fsPromises.statfs);
  await assert.rejects(
    installCore(f.archive, f.cache, f.spec),
    (error) => error === original,
  );
  assert.deepEqual(await readdir(f.cache), []);
});

test(
  "a write failure after space admission removes only its staging tree and permits a fresh install",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const original = Object.assign(
      new Error("ENOSPC: injected late disk-space loss"),
      { code: "ENOSPC" },
    );
    const open = fs.open;
    let injected = false;
    const restore = replaceBuiltin(t, fs, "open", ((...args: unknown[]) => {
      const path = normalize(String(args[0]));
      if (
        !injected &&
        path.startsWith(f.cache + sep) &&
        path.endsWith(join("bin", "codex"))
      ) {
        injected = true;
        queueMicrotask(() => (args.at(-1) as (error: Error) => void)(original));
        return;
      }
      return Reflect.apply(open, fs, args);
    }) as typeof fs.open);
    await assert.rejects(
      installCore(f.archive, f.cache, f.spec),
      (error) => error === original,
    );
    assert.equal(injected, true);
    assert.deepEqual(await readdir(f.cache), []);
    restore();
    const binary = await installCore(f.archive, f.cache, f.spec);
    assert.equal(
      await verifyCoreInstall(dirname(dirname(binary)), f.spec),
      binary,
    );
    assert.equal((await readdir(f.cache)).length, 1);
  },
);

test("verification plus cleanup failures retain both errors and cannot modify an existing installation", async (t) => {
  const f = await fixture(t);
  const goodSpec = { ...f.spec };
  const existing = await installCore(f.archive, f.cache, goodSpec);
  const changed = Buffer.from(await readFile(join(f.source, "bin/codex")));
  changed[0] ^= 1;
  await writeFile(join(f.source, "bin/codex"), changed);
  // Same entry sizes, repinned tiny archive digest, deliberately wrong file hash.
  await f.repack();
  const cleanup = Object.assign(
    new Error("EPERM: injected staging cleanup failure"),
    { code: "EPERM" },
  );
  const remove = fsPromises.rm;
  const removed: string[] = [];
  replaceBuiltin(t, fsPromises, "rm", (async (path, options) => {
    if (String(path).startsWith(join(f.cache, ".synora-core-"))) {
      removed.push(String(path));
      throw cleanup;
    }
    return remove(path, options);
  }) as typeof fsPromises.rm);
  await assert.rejects(installCore(f.archive, f.cache, f.spec), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.cause instanceof Error);
    assert.match(error.cause.message, /Core runtime integrity mismatch/);
    assert.equal(error.errors[0], error.cause);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  assert.equal(removed.length, 1);
  assert.notEqual(removed[0], dirname(dirname(existing)));
  assert.equal(
    await verifyCoreInstall(dirname(dirname(existing)), goodSpec),
    existing,
  );
  await assert.rejects(
    verifyCoreInstall(removed[0], f.spec),
    /integrity mismatch/,
  );
  assert.equal((await readdir(f.cache)).length, 2);
});

test(
  "fatal archive read failure is bounded and retains an explicitly uninstalled staging directory",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const original = Object.assign(
      new Error("EIO: injected extraction read failure"),
      { code: "EIO" },
    );
    const stats = fsPromises.statfs;
    let admitted = false;
    replaceBuiltin(t, fsPromises, "statfs", (async (
      ...args: Parameters<typeof stats>
    ) => {
      const result = await Reflect.apply(stats, fsPromises, args);
      admitted = true;
      return result;
    }) as typeof stats);
    const read = fs.createReadStream;
    let injected: Readable | undefined;
    replaceBuiltin(t, fs, "createReadStream", ((
      ...args: Parameters<typeof read>
    ) => {
      if (admitted && String(args[0]) === f.archive) {
        injected = new Readable({
          read() {
            this.destroy(original);
          },
        });
        return injected as fs.ReadStream;
      }
      return Reflect.apply(read, fs, args);
    }) as typeof read);
    await assert.rejects(installCore(f.archive, f.cache, f.spec), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.match(
        error.message,
        /EIO.*retained uninstalled staging directory/,
      );
      return true;
    });
    assert.ok(injected);
    if (!injected.closed)
      await new Promise<void>((done) => injected!.once("close", done));
    assert.equal(injected.destroyed, true);
    const entries = await readdir(f.cache);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^\.synora-core-/);
    await assert.rejects(verifyCoreInstall(join(f.cache, entries[0]), f.spec));
  },
);

test(
  "a recoverable tar error still drains a multi-chunk archive",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.repack([
      "bin/codex",
      ...Object.keys(f.spec.files).filter((name) => name !== "bin/codex"),
    ]);
    const bytes = gunzipSync(await readFile(f.archive));
    assert.ok(
      bytes.length <= 10 * 1024,
      "Keep the entire deterministic tar below 10 KiB",
    );
    await writeFile(f.archive, bytes);
    f.spec.size = bytes.length;
    f.spec.sha256 = await sha256File(f.archive);
    const original = Object.assign(
      new Error("ENOSPC: injected first-entry open failure"),
      { code: "ENOSPC" },
    );
    const stats = fsPromises.statfs;
    let admitted = false;
    replaceBuiltin(t, fsPromises, "statfs", (async (
      ...args: Parameters<typeof stats>
    ) => {
      const result = await Reflect.apply(stats, fsPromises, args);
      admitted = true;
      return result;
    }) as typeof stats);
    const read = fs.createReadStream;
    let reader: Readable | undefined;
    replaceBuiltin(t, fs, "createReadStream", ((
      ...args: Parameters<typeof read>
    ) => {
      if (admitted && String(args[0]) === f.archive) {
        let sent = false;
        reader = new Readable({
          read() {
            if (!sent) {
              sent = true;
              this.push(bytes.subarray(0, 1024));
            }
          },
        });
        return reader as fs.ReadStream;
      }
      return Reflect.apply(read, fs, args);
    }) as typeof read);
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => {
      failed = resolve;
    });
    const open = fs.open;
    replaceBuiltin(t, fs, "open", ((...args: unknown[]) => {
      const path = normalize(String(args[0]));
      if (
        path.startsWith(f.cache + sep) &&
        path.endsWith(join("bin", "codex"))
      ) {
        queueMicrotask(() => {
          (args.at(-1) as (error: Error) => void)(original);
          failed();
        });
        return;
      }
      return Reflect.apply(open, fs, args);
    }) as typeof open);
    const pending = installCore(f.archive, f.cache, f.spec).then(
      () => assert.fail("Extraction error must not publish"),
      (error: unknown) => error,
    );
    await failure;
    assert.ok(reader);
    // Node pipe() removes its data listener on destination error, preventing
    // tar from reaching EOF. Supply the remaining tiny input only after error.
    const stillReceiving = reader.listenerCount("data") > 0;
    reader.push(bytes.subarray(1024));
    reader.push(null);
    if (!stillReceiving) reader.destroy(original); // bound the red/baseline path
    const error = await pending;
    if (!reader.closed)
      await new Promise<void>((done) => reader!.once("close", done));
    assert.equal(stillReceiving, true);
    assert.equal(error, original);
    assert.equal(reader.destroyed, true);
    assert.deepEqual(await readdir(f.cache), []);
  },
);

test(
  "parser abort retains its actual cause and promptly closes the input",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const stats = fsPromises.statfs;
    let admitted = false;
    replaceBuiltin(t, fsPromises, "statfs", (async (
      ...args: Parameters<typeof stats>
    ) => {
      const result = await Reflect.apply(stats, fsPromises, args);
      admitted = true;
      return result;
    }) as typeof stats);
    const read = fs.createReadStream;
    let reader: Readable | undefined;
    replaceBuiltin(t, fs, "createReadStream", ((
      ...args: Parameters<typeof read>
    ) => {
      if (admitted && String(args[0]) === f.archive) {
        reader = Readable.from([Buffer.from([0x1f, 0x8b, 0x00, 0x00])]);
        return reader as fs.ReadStream;
      }
      return Reflect.apply(read, fs, args);
    }) as typeof read);
    let original: unknown;
    let aborts = 0;
    const emit = Unpack.prototype.emit;
    t.mock.method(
      Unpack.prototype,
      "emit",
      function (this: Unpack, event: string | symbol, ...args: unknown[]) {
        if (event === "abort") {
          original ??= args[0];
          aborts++;
        }
        return Reflect.apply(emit, this, [event, ...args]);
      },
    );
    await assert.rejects(installCore(f.archive, f.cache, f.spec), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.equal((original as NodeJS.ErrnoException).code, "Z_DATA_ERROR");
      assert.match(error.message, /retained uninstalled staging directory/);
      return true;
    });
    assert.equal(aborts, 1);
    assert.ok(reader);
    if (!reader.closed)
      await new Promise<void>((done) => reader!.once("close", done));
    assert.equal(reader.destroyed, true);
    const entries = await readdir(f.cache);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^\.synora-core-/);
    await assert.rejects(verifyCoreInstall(join(f.cache, entries[0]), f.spec));
  },
);

test(
  "fatal read after opening an entry closes its owned output descriptor",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await f.repack([
      "bin/codex",
      ...Object.keys(f.spec.files).filter((name) => name !== "bin/codex"),
    ]);
    const bytes = gunzipSync(await readFile(f.archive));
    assert.ok(bytes.length <= 10 * 1024);
    const original = Object.assign(
      new Error("EIO: injected read failure after entry open"),
      { code: "EIO" },
    );
    const stats = fsPromises.statfs;
    let admitted = false;
    replaceBuiltin(t, fsPromises, "statfs", (async (
      ...args: Parameters<typeof stats>
    ) => {
      const result = await Reflect.apply(stats, fsPromises, args);
      admitted = true;
      return result;
    }) as typeof stats);
    const read = fs.createReadStream;
    let reader: Readable | undefined;
    replaceBuiltin(t, fs, "createReadStream", ((
      ...args: Parameters<typeof read>
    ) => {
      if (admitted && String(args[0]) === f.archive) {
        let sent = false;
        reader = new Readable({
          read() {
            if (!sent) {
              sent = true;
              this.push(bytes.subarray(0, 512));
            }
          },
        });
        return reader as fs.ReadStream;
      }
      return Reflect.apply(read, fs, args);
    }) as typeof read);
    const owned = new Set<number>();
    const close = fs.close;
    // The failing baseline also closes only its own tracked descriptor at teardown.
    t.after(async () => {
      for (const fd of owned)
        await new Promise<void>((done, reject) =>
          close(fd, (error) => (error ? reject(error) : done())),
        );
    });
    let closed!: () => void;
    const outputClosed = new Promise<void>((done) => {
      closed = done;
    });
    replaceBuiltin(t, fs, "close", ((
      fd: number,
      callback: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      close(fd, (error) => {
        if (!error && owned.delete(fd)) closed();
        callback(error);
      });
    }) as typeof close);
    const open = fs.open;
    replaceBuiltin(t, fs, "open", ((...args: unknown[]) => {
      const path = normalize(String(args[0]));
      if (
        path.startsWith(f.cache + sep) &&
        path.endsWith(join("bin", "codex"))
      ) {
        const callback = args.at(-1) as (
          error: NodeJS.ErrnoException | null,
          fd: number,
        ) => void;
        return Reflect.apply(open, fs, [
          ...args.slice(0, -1),
          (error: NodeJS.ErrnoException | null, fd: number) => {
            if (!error) owned.add(fd);
            callback(error, fd);
            reader!.destroy(original);
          },
        ]);
      }
      return Reflect.apply(open, fs, args);
    }) as typeof open);
    await assert.rejects(installCore(f.archive, f.cache, f.spec), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.match(error.message, /retained uninstalled staging directory/);
      return true;
    });
    assert.ok(reader);
    if (!reader.closed)
      await new Promise<void>((done) => reader!.once("close", done));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        outputClosed,
        new Promise<void>((done) => {
          timer = setTimeout(done, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.equal(
      owned.size,
      0,
      "A parser abort must not strand its open output file",
    );
    const entries = await readdir(f.cache);
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^\.synora-core-/);
    await assert.rejects(verifyCoreInstall(join(f.cache, entries[0]), f.spec));
  },
);
