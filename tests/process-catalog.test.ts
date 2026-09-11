import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  createProcessCatalog,
  processResourceCleanup,
} from "../src/engine/process-catalog";
import { prepareAxiomProcess } from "../src/engine/axiom-process";
import {
  prepareResponsesProcess,
  responsesBridge,
  type ResponsesAdapter,
} from "../src/engine/responses-provider";
import { AppServerTransport } from "../src/engine/app-server-transport";
import {
  PROTOCOL_VERSION,
  type Integration,
  type ModelCapabilities,
} from "../src/shared/contracts";

const bounded = { timeout: 10000 };
type Prepared = Awaited<ReturnType<typeof prepareAxiomProcess>>;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// All disk writes are confined to this test's exclusively-created temporary root.
// Version/catalog fixtures do not execute Core, access accounts or contact a model.
async function state(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "synora-process-catalog-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function replaceBuiltin<T extends object, K extends keyof T>(
  t: TestContext,
  target: T,
  key: K,
  value: T[K],
) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    ...descriptor,
    value,
  });
  syncBuiltinESMExports();
  t.after(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
    syncBuiltinESMExports();
  });
}
function fakeVersion(t: TestContext) {
  const fake = (() => {
    throw Error("Unexpected unpromisified executable call");
  }) as unknown as typeof childProcess.execFile;
  Object.defineProperty(fake, promisify.custom, {
    value: async (_file: string, args: string[]) => {
      assert.deepEqual(args, ["--version"]);
      return { stdout: `codex-cli ${PROTOCOL_VERSION}\n`, stderr: "" };
    },
  });
  replaceBuiltin(t, childProcess, "execFile", fake);
}
function options(root: string) {
  return {
    executable: "controlled-version-fixture-only",
    stateDirectory: root,
    cwd: root,
    endpoint: "http://127.0.0.1:9/codex/v1",
    model: "Controlled-Model",
    profile: "high",
    context: 4096,
  };
}
function model(description = "Controlled provider catalog"): ModelCapabilities {
  return {
    id: "Controlled-Model",
    context_window: 8192,
    context_window_options: [4096, 8192],
    reasoning_efforts: ["high"],
    default_reasoning_effort: "high",
    providerModel: {
      provider: "compatible",
      aliases: [],
      inputModalities: ["text", "image"],
      description,
    },
  };
}
function adapter(description = "Controlled provider catalog") {
  let closes = 0;
  const entry = model(description);
  const value: ResponsesAdapter = {
    id: "synora_catalog_fixture",
    name: "Catalog fixture",
    allowAnonymous: true,
    models: async () => [entry],
    validate: (models, id) => {
      assert.equal(models[0].id, id);
      return models[0];
    },
    bridge: async () => ({
      endpoint: "http://127.0.0.1:9",
      token: "controlled-private-capability",
      close: async () => {
        closes++;
      },
    }),
  };
  return { value, closes: () => closes };
}
function coreConfig(prepared: Prepared) {
  const entries: [string, unknown][] = [];
  for (let i = 0; i < prepared.args.length; i++) {
    if (prepared.args[i] !== "-c") continue;
    const value = prepared.args[++i],
      split = value.indexOf("=");
    entries.push([value.slice(0, split), JSON.parse(value.slice(split + 1))]);
  }
  return Object.fromEntries(entries);
}
function catalogPath(prepared: Prepared): string {
  const path = coreConfig(prepared).model_catalog_json;
  assert.equal(typeof path, "string");
  return path as string;
}
async function readCatalog(path: string) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}
function axiomCatalog(t: TestContext) {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.match(
      url,
      /^http:\/\/127\.0\.0\.1:9\/(?:other\/)?codex\/v1\/models$/,
    );
    return new Response(
      JSON.stringify({
        data: [{ ...model(), input_modalities: ["text", "image"] }],
        models: [{ slug: "Controlled-Model", base_instructions: url }],
      }),
    );
  });
}
function listeners(t: TestContext, fail = false) {
  const servers: Server[] = [],
    original = Server.prototype.listen;
  replaceBuiltin(t, Server.prototype, "listen", function (
    this: Server,
    ...args: unknown[]
  ) {
    servers.push(this);
    assert.equal(args[0], 0);
    assert.equal(args[1], "127.0.0.1");
    if (fail) {
      queueMicrotask(() =>
        this.emit("error", Error("injected listener startup failure")),
      );
      return this;
    }
    return Reflect.apply(original, this, args);
  } as typeof Server.prototype.listen);
  t.after(async () => {
    for (const server of servers)
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
  });
  return servers;
}

test(
  "parallel catalogs in one home have distinct immutable paths, full JSON and private modes",
  bounded,
  async (t) => {
    const root = await state(t),
      sentinel = join(root, "axiom-model-catalog.json");
    await fs.writeFile(sentinel, "existing fixed catalog must be untouched");
    const data = ["Supervisor-α", "Worker-β"].map((name) => ({
      models: [{ slug: name, description: name.repeat(32768) }],
    }));
    const leases = await Promise.all(
      data.map((value) => createProcessCatalog(root, value)),
    );
    try {
      assert.notEqual(leases[0].path, leases[1].path);
      for (let i = 0; i < leases.length; i++) {
        const { path } = leases[i];
        assert.equal(isAbsolute(path), true);
        assert.equal(dirname(dirname(path)), await fs.realpath(root));
        assert.deepEqual(await fs.readdir(dirname(path)), ["catalog.json"]);
        if (process.platform !== "win32") {
          assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
          assert.equal((await fs.stat(dirname(path))).mode & 0o777, 0o700);
        }
        for (let read = 0; read < 5; read++)
          assert.deepEqual(await readCatalog(path), data[i]);
      }
      await leases[0].cleanup();
      assert.deepEqual(await readCatalog(leases[1].path), data[1]);
      assert.equal(
        await fs.readFile(sentinel, "utf8"),
        "existing fixed catalog must be untouched",
      );
    } finally {
      await Promise.all(leases.map((lease) => lease.cleanup()));
    }
    assert.deepEqual(await fs.readdir(root), ["axiom-model-catalog.json"]);
  },
);

test(
  "catalog publication is an atomic rename; the final path is absent until the full write closes",
  bounded,
  async (t) => {
    const root = await state(t),
      original = fs.rename;
    const ready = deferred<{ source: string; target: string }>();
    const release = deferred<void>();
    replaceBuiltin(t, fs, "rename", async (source, target) => {
      ready.resolve({ source: String(source), target: String(target) });
      await release.promise;
      await original(source, target);
    });
    const value = {
      models: [{ slug: "Atomic", description: "x".repeat(131072) }],
    };
    const creating = createProcessCatalog(root, value);
    void creating.catch((error) => ready.reject(error));
    try {
      const { source, target } = await ready.promise;
      assert.deepEqual(await readCatalog(source), value);
      await assert.rejects(fs.readFile(target), { code: "ENOENT" });
    } finally {
      release.resolve();
      const lease = await creating;
      try {
        assert.deepEqual(await readCatalog(lease.path), value);
      } finally {
        await lease.cleanup();
      }
    }
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "catalog cleanup shares concurrent calls, is idempotent and accepts already-absent exact files",
  bounded,
  async (t) => {
    const root = await state(t);
    const lease = await createProcessCatalog(root, { models: [] });
    await fs.unlink(lease.path);
    const first = lease.cleanup(),
      second = lease.cleanup();
    assert.equal(first, second);
    await Promise.all([first, second]);
    await lease.cleanup();
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "unserializable catalogs fail before a temporary path is created",
  bounded,
  async (t) => {
    const root = await state(t);
    const cyclic: { models: unknown[] } = { models: [] };
    cyclic.models.push(cyclic);
    await assert.rejects(createProcessCatalog(root, cyclic), /circular/i);
    await assert.rejects(
      createProcessCatalog(root, { models: [1n] }),
      /BigInt/i,
    );
    await assert.rejects(
      createProcessCatalog(root, {
        models: [],
        toJSON: () => undefined,
      } as { models: unknown[] }),
      /not JSON serializable/,
    );
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "partial disk-write failure removes its staging file and private directory",
  bounded,
  async (t) => {
    const root = await state(t),
      original = fs.writeFile;
    replaceBuiltin(t, fs, "writeFile", async (path, _data, options) => {
      await original(path, "{partial", options);
      throw Error("injected partial write failure");
    });
    await assert.rejects(
      createProcessCatalog(root, { models: [] }),
      /injected partial write failure/,
    );
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "rename failure removes only the failed catalog, leaving a concurrent lease readable",
  bounded,
  async (t) => {
    const root = await state(t),
      retained = await createProcessCatalog(root, { models: ["retained"] });
    replaceBuiltin(t, fs, "rename", async () => {
      throw Error("injected rename failure");
    });
    try {
      await assert.rejects(
        createProcessCatalog(root, { models: ["failed"] }),
        /injected rename failure/,
      );
      assert.deepEqual(await readCatalog(retained.path), {
        models: ["retained"],
      });
      assert.deepEqual(await fs.readdir(root), [
        dirname(retained.path).split(/[\\/]/).at(-1),
      ]);
    } finally {
      await retained.cleanup();
    }
  },
);

test(
  "cleanup never recursively removes unexpected contents and can retry after an obstruction",
  bounded,
  async (t) => {
    const root = await state(t),
      lease = await createProcessCatalog(root, { models: [] });
    const unrelated = join(dirname(lease.path), "not-owned.txt");
    await fs.writeFile(unrelated, "preserve");
    await assert.rejects(
      lease.cleanup(),
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOTEMPTY" || error.code === "EEXIST",
    );
    assert.equal(await fs.readFile(unrelated, "utf8"), "preserve");
    await assert.rejects(fs.readFile(lease.path), { code: "ENOENT" });
    await fs.unlink(unrelated);
    await lease.cleanup();
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "combined cleanup attempts all resources, preserves errors and retries failed cleanup",
  bounded,
  async () => {
    const calls: string[] = [],
      bridgeError = Error("bridge close failure"),
      fileError = Error("file cleanup failure");
    let failing = true;
    const cleanup = processResourceCleanup(
      async () => {
        calls.push("bridge");
        if (failing) throw bridgeError;
      },
      async () => {
        calls.push("catalog");
        if (failing) throw fileError;
      },
    );
    const first = cleanup(),
      second = cleanup();
    assert.equal(first, second);
    await assert.rejects(first, (error: AggregateError) => {
      assert.deepEqual(error.errors, [bridgeError, fileError]);
      return true;
    });
    assert.deepEqual(calls, ["bridge", "catalog"]);
    failing = false;
    await cleanup();
    await cleanup();
    assert.deepEqual(calls, ["bridge", "catalog", "bridge", "catalog"]);
  },
);

test(
  "same-home Axiom preparations retain independent catalogs and bridges until their own cleanup",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    axiomCatalog(t);
    const servers = listeners(t);
    const prepared = await Promise.all([
      prepareAxiomProcess(options(root)),
      prepareAxiomProcess({
        ...options(root),
        endpoint: "http://127.0.0.1:9/other/codex/v1",
      }),
    ]);
    try {
      assert.notEqual(catalogPath(prepared[0]), catalogPath(prepared[1]));
      assert.equal(prepared[0].env.CODEX_HOME, prepared[1].env.CODEX_HOME);
      for (let i = 0; i < prepared.length; i++) {
        const catalog = await readCatalog(catalogPath(prepared[i]));
        assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
        assert.equal(
          catalog.models[0].base_instructions,
          `http://127.0.0.1:9/${i ? "other/" : ""}codex/v1/models`,
        );
      }
      assert.equal(servers.filter((s) => s.listening).length, 2);
      await prepared[0].cleanup!();
      await assert.rejects(fs.readFile(catalogPath(prepared[0])), {
        code: "ENOENT",
      });
      assert.equal(servers.filter((s) => s.listening).length, 1);
      assert.equal(
        (await readCatalog(catalogPath(prepared[1]))).models[0].slug,
        "Controlled-Model",
      );
    } finally {
      await Promise.all(prepared.map((p) => p.cleanup!()));
    }
    assert.equal(
      servers.some((s) => s.listening),
      false,
    );
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "same-adapter Responses preparations in a shared home preserve each catalog and private cleanup",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    const adapters = [adapter("supervisor catalog"), adapter("worker catalog")];
    const prepared = await Promise.all(
      adapters.map((a) =>
        prepareResponsesProcess({ ...options(root), context: null }, a.value),
      ),
    );
    try {
      assert.notEqual(catalogPath(prepared[0]), catalogPath(prepared[1]));
      assert.equal(prepared[0].env.CODEX_HOME, prepared[1].env.CODEX_HOME);
      assert.equal(
        coreConfig(prepared[0]).model_provider,
        coreConfig(prepared[1]).model_provider,
      );
      for (let i = 0; i < prepared.length; i++) {
        const catalog = await readCatalog(catalogPath(prepared[i]));
        assert.equal(
          catalog.models[0].description,
          i ? "worker catalog" : "supervisor catalog",
        );
        assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
        assert.equal(catalog.models[0].default_reasoning_level, "high");
      }
      await prepared[0].cleanup!();
      await prepared[0].cleanup!();
      assert.equal(adapters[0].closes(), 1);
      assert.equal(adapters[1].closes(), 0);
      assert.equal(
        (await readCatalog(catalogPath(prepared[1]))).models[0].description,
        "worker catalog",
      );
    } finally {
      await Promise.all(prepared.map((p) => p.cleanup!()));
    }
    assert.deepEqual(
      adapters.map((a) => a.closes()),
      [1, 1],
    );
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "both preparers remove their catalog if MCP configuration fails before bridge creation",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    axiomCatalog(t);
    const servers = listeners(t),
      a = adapter();
    let bridgeStarts = 0;
    a.value.bridge = async () => {
      bridgeStarts++;
      throw Error("must not start");
    };
    const integrations = [{} as Integration];
    await assert.rejects(
      prepareAxiomProcess({ ...options(root), integrations }),
      /Required/,
    );
    await assert.rejects(
      prepareResponsesProcess(
        { ...options(root), context: null, integrations },
        a.value,
      ),
      /Required/,
    );
    assert.equal(bridgeStarts, 0);
    assert.equal(servers.length, 0);
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "bridge startup failures in both preparers clean their catalog without a listening server",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    axiomCatalog(t);
    const servers = listeners(t, true),
      a = adapter();
    a.value.bridge = (opts) =>
      responsesBridge({
        endpoint: opts.endpoint,
        token: opts.token,
        allowAnonymous: true,
        label: "Controlled",
        errorPrefix: "CONTROLLED",
        envelope: () => {
          throw Error("No model request allowed");
        },
      });
    await assert.rejects(
      prepareAxiomProcess(options(root)),
      /injected listener startup failure/,
    );
    await assert.rejects(
      prepareResponsesProcess({ ...options(root), context: null }, a.value),
      /injected listener startup failure/,
    );
    assert.equal(servers.length, 2);
    assert.equal(
      servers.some((s) => s.listening),
      false,
    );
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "Axiom failure after bridge creation closes the bridge and deletes its catalog before rejecting",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    axiomCatalog(t);
    const servers = listeners(t),
      stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (value: unknown) => {
      if (value === "synora_axiom")
        throw Error("injected argument serialization failure");
      return stringify(value);
    });
    await assert.rejects(
      prepareAxiomProcess(options(root)),
      /injected argument serialization failure/,
    );
    assert.equal(servers.length, 1);
    assert.equal(servers[0].listening, false);
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "Responses failure after bridge creation closes the bridge and deletes its catalog before rejecting",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    const servers = listeners(t),
      a = adapter();
    a.value.bridge = async (opts) => {
      const bridge = await responsesBridge({
        endpoint: opts.endpoint,
        token: opts.token,
        allowAnonymous: true,
        label: "Controlled",
        errorPrefix: "CONTROLLED",
        envelope: () => {
          throw Error("No model request allowed");
        },
      });
      return {
        endpoint: bridge.endpoint,
        close: bridge.close,
        get token(): string {
          throw Error("injected bridge metadata failure");
        },
      };
    };
    await assert.rejects(
      prepareResponsesProcess({ ...options(root), context: null }, a.value),
      /injected bridge metadata failure/,
    );
    assert.equal(servers.length, 1);
    assert.equal(servers[0].listening, false);
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "a failed bridge close cannot skip catalog removal or hide a preparation error",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    const a = adapter(),
      bridgeError = Error("injected close failure"),
      prepareError = Error("injected metadata failure");
    a.value.bridge = async () => ({
      endpoint: "http://127.0.0.1:9",
      get token(): string {
        throw prepareError;
      },
      close: async () => {
        throw bridgeError;
      },
    });
    await assert.rejects(
      prepareResponsesProcess({ ...options(root), context: null }, a.value),
      (error: AggregateError) => {
        assert.equal(error.cause, prepareError);
        assert.deepEqual(error.errors, [prepareError, bridgeError]);
        return true;
      },
    );
    assert.deepEqual(await fs.readdir(root), []);
    a.value.bridge = async () => ({
      endpoint: "http://127.0.0.1:9",
      token: "fixture",
      close: async () => {
        throw bridgeError;
      },
    });
    const prepared = await prepareResponsesProcess(
      { ...options(root), context: null },
      a.value,
    );
    await assert.rejects(prepared.cleanup!(), bridgeError);
    assert.deepEqual(await fs.readdir(root), []);
  },
);

test(
  "transport shutdown, unexpected child exit and spawn failure each release their catalog exactly once",
  bounded,
  async (t) => {
    const root = await state(t);
    fakeVersion(t);
    for (const mode of ["shutdown", "exit", "spawn-error"]) {
      const a = adapter(),
        prepared = await prepareResponsesProcess(
          { ...options(root), context: null },
          a.value,
        );
      const ready = deferred<void>(),
        closed = deferred<void>();
      const path = catalogPath(prepared);
      const transport = new AppServerTransport({
        ...prepared,
        executable:
          mode === "spawn-error"
            ? join(root, "nonexistent-owned-fixture")
            : process.execPath,
        args:
          mode === "shutdown"
            ? [
                "-e",
                'process.stdout.write(JSON.stringify({method:"ready"})+String.fromCharCode(10));process.stdin.resume();',
              ]
            : ["-e", "process.exit(0)"],
        onNotification: () => ready.resolve(),
        onRequest: () => {
          throw Error("No model requests in this fixture");
        },
        onClose: (error) => {
          if (mode === "shutdown") ready.reject(error);
          closed.resolve();
        },
      });
      try {
        if (mode === "shutdown") {
          await ready.promise;
          assert.equal(
            (await readCatalog(path)).models[0].slug,
            "Controlled-Model",
          );
          assert.equal(a.closes(), 0);
        } else await closed.promise;
        await transport.close();
        await transport.close();
        await prepared.cleanup!();
        await assert.rejects(fs.readFile(path), { code: "ENOENT" });
        assert.equal(a.closes(), 1, mode);
      } finally {
        await transport.close();
      }
    }
    assert.deepEqual(await fs.readdir(root), []);
  },
);
