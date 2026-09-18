import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { CoreUpdateStatus } from "../shared/core-update";
import {
  installCore,
  managedCore,
  BUNDLED_CORE_VERSION,
  legacyCorePackage,
  sha256File,
  type CoreSelection,
} from "./core-runtime";
import {
  qualifiedCore,
  qualifiedCoreUpdates,
  compareCoreVersions,
  type QualifiedCore,
} from "./qualified-core";
import { AppServerTransport } from "./app-server-transport";
import { appServerEnvironment } from "./axiom-process";
import { parseResponse } from "./protocol-validation";
import { CoreChannel } from "./core-channel";

const pointerSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    generation: z.string().uuid().nullable(),
  })
  .strict();
const stateSchema = z
  .object({
    active: pointerSchema,
    previous: pointerSchema.nullable(),
    recoveryId: z.string().uuid().nullable(),
    automatic: z.boolean(),
    failedAutomaticVersion: z.string().nullable().optional(),
    latestVersion: z.string().nullable(),
    checkedAt: z.number().nullable(),
    checks: z.array(z.string()).default([]),
    message: z.string().optional(),
    restoreState: z.unknown().optional(),
    restoreTrees: z
      .object({
        id: z.string().uuid(),
        names: z.array(z.enum(["app-server", "accounts"])),
      })
      .strict()
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
const filesSchema = z.record(
  z.string(),
  z.tuple([z.number().int().nonnegative(), z.string().regex(/^[a-f0-9]{64}$/)]),
);
const baseline = (version = BUNDLED_CORE_VERSION): State => ({
  active: { version, generation: null },
  previous: null,
  recoveryId: null,
  automatic: true,
  latestVersion: null,
  checkedAt: null,
  checks: [],
});
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function atomicJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** Copy only regular owned data; reject links/sockets, never follow workspace links.
 * Content hashes are rechecked after copying. No workspace or external app data. */
async function dataTree(source: string, destination?: string) {
  const files: Record<string, [number, string]> = {};
  const walk = async (relative: string) => {
    const path = join(source, relative),
      info = await lstat(path);
    if (info.isSymbolicLink())
      throw Error(`Recovery snapshot refuses a symbolic link: ${relative}`);
    if (info.isDirectory()) {
      if (destination)
        await mkdir(join(destination, relative), {
          recursive: true,
          mode: 0o700,
        });
      for (const entry of (await readdir(path)).sort())
        await walk(relative ? `${relative}/${entry}` : entry);
    } else if (info.isFile()) {
      const hash = await sha256File(path);
      if (destination) {
        const target = join(destination, relative);
        await copyFile(
          path,
          target,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
        await chmod(target, info.mode & 0o100 ? 0o700 : 0o600);
        if ((await sha256File(target)) !== hash)
          throw Error("Core data changed during snapshot; update cancelled");
      }
      files[relative] = [info.size, hash];
    } else
      throw Error(`Recovery snapshot refuses a non-regular entry: ${relative}`);
  };
  await walk("");
  return files;
}
type Hooks = {
  idle(): void;
  pause(): Promise<void>;
  resume(): void;
  state(): unknown;
  restore(state: unknown): void;
};
export type CoreUpdaterOptions = {
  channel?: CoreChannel | false;
  notify?: (message: string) => void;
  disabledReason?: string;
  // Trusted dependency injection for tests; none are renderer/HTTP parameters.
  fetch?: typeof fetch;
  lookup?: (version: string) => QualifiedCore;
  available?: readonly string[];
  probe?: (executable: string, version: string, home: string) => Promise<void>;
  bundled?: () => Promise<string>;
  bundledVersion?: string;
  archive?: (
    release: QualifiedCore,
    directory: string,
    signal: AbortSignal,
  ) => Promise<string>;
  initialDelayMs?: number;
  intervalMs?: number;
  idleRetryMs?: number;
};
export async function probeCore(
  executable: string,
  version: string,
  home: string,
) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const env = appServerEnvironment(home);
  const result = await promisify(execFile)(executable, ["--version"], {
    env,
    cwd: home,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (result.stdout.trim() !== `codex-cli ${version}`)
    throw Error("Candidate executable version mismatch");
  const transport = new AppServerTransport({
    executable,
    cwd: home,
    env,
    requestTimeoutMs: 10000,
    args: [
      "app-server",
      "--stdio",
      "-c",
      "analytics.enabled=false",
      "-c",
      "feedback.enabled=false",
    ],
    onNotification: () => {},
    onClose: () => {},
    onRequest: (r) =>
      transport.respond(r.id, {
        error: {
          code: -32601,
          message: "Updater never executes model requests",
        },
      }),
  });
  try {
    const initialized = parseResponse(
      "initialize",
      await transport.request("initialize", {
        clientInfo: { name: "synora_runtime_updater", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      }),
    );
    if (resolve(initialized.codexHome) !== resolve(home))
      throw Error("Core did not use its isolated update-probe home");
    transport.notify("initialized");
    // Native, isolated, no inference or account access. Check the actual APIs
    // used to load settings/history, not only the process version banner.
    z.object({ config: z.record(z.unknown()), origins: z.record(z.unknown()), layers: z.array(z.unknown()).nullable() })
      .parse(await transport.request("config/read", { includeLayers: false }));
    z.object({ data: z.array(z.unknown()), nextCursor: z.string().nullable() })
      .parse(await transport.request("thread/list", { limit: 1 }));
    return initialized;
  } finally {
    await transport.close();
  }
}
/** One service-owned updater. Discovery cannot change the trust catalog.
 * Core homes keep stable absolute paths: Core SQLite history can contain paths.
 * Recovery copies are immutable; rollback is journaled before directory moves. */
export class CoreUpdater {
  private state: State;
  private path: string;
  private timer?: ReturnType<typeof setTimeout>;
  private controller = new AbortController();
  private checkJob?: Promise<CoreUpdateStatus>;
  private job?: Promise<CoreUpdateStatus>;
  private phase: CoreUpdateStatus["phase"] = "idle";
  private message =
    "Using the bundled pinned App Server. Availability is not qualification.";
  private checks: string[] = [];
  private fault?: string;
  private closed = false;
  private automaticHooks?: Hooks;
  private lookup: (version: string) => QualifiedCore;
  private channel?: CoreChannel;
  constructor(
    private root: string,
    private options: CoreUpdaterOptions = {},
  ) {
    this.root = resolve(root);
    this.path = join(root, "runtime-updates", "active.json");
    this.channel = options.channel === false ? undefined : options.channel ??
      (options.lookup ? undefined : new CoreChannel(this.root, { fetch: options.fetch }));
    this.lookup = options.lookup ?? ((version) => {
      try { return qualifiedCore(version); }
      catch {
        if (!this.channel) throw Error("No qualified Core release");
        // Already-selected runtimes retain their signed immutable authorization
        // across network outages and catalog expiry.
        try { return this.channel.installed(version); } catch { /* candidate */ }
        const candidate = this.channel.candidates().find(r => r.package.version === version);
        if (!candidate) throw Error("No signed qualified Core release for this platform");
        return candidate;
      }
    });
    try {
      this.state = existsSync(this.path)
        ? stateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
        : baseline(options.bundledVersion);
      this.lookup(this.state.active.version);
      this.checks = this.state.checks;
      if (this.state.message) this.message = this.state.message;
    } catch (e) {
      this.state = baseline(options.bundledVersion);
      this.fault = `Cannot read the saved runtime selection; no silent fallback: ${errorText(e)}`;
    }
  }
  get busy() {
    return !!this.job;
  }
  /** Replay a committed rollback state before opening any Core process. */
  recoverState(restore: (state: unknown) => void) {
    if (!Object.hasOwn(this.state, "restoreState")) return;
    if (this.state.restoreTrees) {
      const { id, names } = this.state.restoreTrees;
      const directory = join(this.root, "runtime-updates", "generations", id);
      mkdirSync(join(directory, "after-upgrade"), {
        recursive: true,
        mode: 0o700,
      });
      for (const name of names) {
        const staged = join(directory, "restore-stage", name),
          current = join(this.root, name),
          retained = join(directory, "after-upgrade", name);
        if (existsSync(staged)) {
          if (existsSync(current)) {
            if (existsSync(retained))
              throw Error(
                "Recovery journal has conflicting directories; no data overwritten",
              );
            renameSync(current, retained);
          }
          renameSync(staged, current);
        } else if (!existsSync(current))
          throw Error("Recovery journal is missing its restored data");
      }
    }
    restore(this.state.restoreState);
    const { restoreState: _state, restoreTrees: _trees, ...next } = this.state;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(next));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, this.path);
      this.state = next;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  get dataRoot() {
    if (this.fault) throw Error(this.fault);
    return this.root;
  }
  selection(): CoreSelection {
    if (this.fault) throw Error(this.fault);
    const version = this.state.active.version;
    return { version, executable: () => this.executable(version) };
  }
  private executable(version: string) {
    if (version === (this.options.bundledVersion ?? BUNDLED_CORE_VERSION))
      return this.options.bundled?.() ?? managedCore(this.root);
    if (!this.options.bundled && version === legacyCorePackage().version)
      return managedCore(this.root, version);
    const spec = this.lookup(version).package;
    return installCore(
      join(this.root, "runtime-updates", "archives", spec.version, spec.file),
      join(this.root, "runtime-updates", "runtimes"),
      spec,
    );
  }
  snapshot(): CoreUpdateStatus {
    const eligible =
      (
        this.options.available ??
        [BUNDLED_CORE_VERSION, ...qualifiedCoreUpdates.map((v) => v.package.version),
          ...(this.channel?.candidates().map(r => r.package.version) ?? [])]
      )
        .filter((v) => {
          try {
            this.lookup(v);
            return compareCoreVersions(v, this.state.active.version) > 0;
          } catch {
            return false;
          }
        })
        .sort(compareCoreVersions)
        .at(-1) ?? null;
    return {
      currentVersion: this.state.active.version,
      latestVersion: this.state.latestVersion,
      eligibleVersion: eligible,
      checkedAt: this.state.checkedAt,
      automatic: this.state.automatic,
      checking: !!this.checkJob,
      phase: this.phase,
      message: this.fault ?? this.message,
      checks: [...this.checks],
      previousVersion: this.state.previous?.version ?? null,
      recoveryId: this.state.recoveryId,
      disabledReason: this.fault ?? this.options.disabledReason ?? null,
    };
  }
  start(hooks?: Hooks) {
    if (hooks) this.automaticHooks = hooks;
    if (!this.closed && this.state.automatic && !this.timer)
      this.schedule(this.options.initialDelayMs ?? 30000);
  }
  private schedule(delay: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.automaticCycle();
    }, delay);
    this.timer.unref();
  }
  private async automaticCycle() {
    let retryIdle = false;
    try {
      await this.check();
      const version = this.snapshot().eligibleVersion;
      if (
        !this.closed &&
        this.state.automatic &&
        this.automaticHooks &&
        version &&
        version !== this.state.failedAutomaticVersion &&
        !this.busy &&
        !this.fault &&
        !this.options.disabledReason
      ) {
        // Admission remains synchronous inside install(). Busy conversations
        // defer the update; no cancellation, approval or inference is invented.
        let install: Promise<CoreUpdateStatus>;
        try {
          install = this.install(version, this.automaticHooks);
        } catch {
          retryIdle = true;
          this.message = `Core ${version} is qualified and queued. Waiting for idle sessions before automatic installation.`;
          return;
        }
        try {
          await install;
        } catch (e) {
          await this.save({ ...this.state, failedAutomaticVersion: version });
          this.options.notify?.(
            `Automatic Core update failed: ${errorText(e)}. Check the retained runtime and recovery status; no automatic retry loop.`,
          );
        }
      }
    } catch (error) {
      this.fault = `Automatic update state could not be recorded: ${errorText(error)}`;
      this.message = this.fault;
      this.options.notify?.(this.fault);
    } finally {
      if (!this.closed && !this.fault && this.state.automatic)
        this.schedule(
          retryIdle
            ? (this.options.idleRetryMs ?? 60000)
            : (this.options.intervalMs ?? 6 * 60 * 60 * 1000),
        );
    }
  }
  async automatic(enabled: boolean) {
    if (this.closed || this.busy || this.checkJob || this.fault)
      throw Error("Wait for the runtime operation to finish");
    await this.save({ ...this.state, automatic: enabled });
    clearTimeout(this.timer);
    this.timer = undefined;
    if (enabled) this.start();
    return this.snapshot();
  }
  private async save(state: State) {
    await atomicJSON(this.path, state);
    this.state = state;
  }
  check(): Promise<CoreUpdateStatus> {
    if (this.checkJob) return this.checkJob;
    if (this.closed || this.busy || this.fault)
      return Promise.resolve(this.snapshot());
    this.checkJob = this.checkLatest().finally(() => {
      this.checkJob = undefined;
    });
    return this.checkJob.then(() => this.snapshot());
  }
  private async checkLatest() {
    // The signed channel is authoritative. Ordinary startup must not wait for
    // GitHub availability, rate limits, or an unrelated newer upstream release.
    if (!this.channel) return this.checkUpstream();
    if (this.channel && !this.closed) {
      try {
        await this.channel.refresh(this.controller.signal);
        const eligible = this.snapshot().eligibleVersion;
        const changed = eligible && eligible !== this.state.latestVersion;
        await this.save({ ...this.state, latestVersion: eligible ?? this.state.active.version, checkedAt: Date.now() });
        this.message = eligible
          ? `Core ${eligible} is available from the signed channel. Synora will verify it locally and activate it when idle.`
          : "No newer authorized Core update is available. Installed runtime unchanged.";
        if (changed) this.options.notify?.(this.message);
      } catch (e) {
        if (!this.closed) this.message = `Signed Core channel unavailable; installed runtime unchanged. ${errorText(e)}`;
      }
    }
    return this.snapshot();
  }
  private async checkUpstream() {
    try {
      const response = await (this.options.fetch ?? fetch)(
        "https://api.github.com/repos/openai/codex/releases/latest",
        {
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(10000),
          ]),
          redirect: "error",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "Synora-runtime-check",
          },
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw Error(`Version check HTTP ${response.status}`);
      }
      if (!response.body) throw Error("Empty version metadata");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.length;
          if (bytes > 2 * 1024 * 1024)
            throw Error("Version metadata too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const value = z
        .object({
          tag_name: z.string().regex(/^rust-v\d+\.\d+\.\d+$/),
          draft: z.literal(false),
          prerelease: z.literal(false),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const version = value.tag_name.slice(6);
      compareCoreVersions(version, this.state.active.version);
      const changed = version !== this.state.latestVersion;
      await this.save({
        ...this.state,
        latestVersion: version,
        checkedAt: Date.now(),
      });
      this.message =
        compareCoreVersions(version, this.state.active.version) > 0
          ? `Core ${version} is available upstream. Only versions qualified for this Synora build can be installed.`
          : "No newer stable upstream version was found.";
      if (
        changed &&
        compareCoreVersions(version, this.state.active.version) > 0
      )
        this.options.notify?.(this.message);
    } catch (e) {
      if (!this.closed)
        this.message = `Update check failed; installed runtime unchanged. ${errorText(e)}`;
    }
    return this.snapshot();
  }
  install(version: string, hooks: Hooks) {
    return this.exclusive(() => this.installIdle(version, hooks), hooks);
  }
  rollback(recoveryId: string, hooks: Hooks) {
    return this.exclusive(() => this.rollbackIdle(recoveryId, hooks), hooks);
  }
  private exclusive(action: () => Promise<void>, hooks: Hooks) {
    if (
      this.closed ||
      this.job ||
      this.checkJob ||
      this.fault ||
      this.options.disabledReason
    )
      throw Error(
        this.fault ??
          this.options.disabledReason ??
          "Wait for the runtime operation to finish",
      );
    hooks.idle(); // synchronous admission; no timer/deferred destructive action
    this.phase = "preparing";
    this.checks = [];
    this.job = Promise.resolve()
      .then(action)
      .then(() => this.snapshot())
      .catch((e) => {
        this.phase = "failed";
        this.message = errorText(e);
        throw e;
      })
      .finally(() => {
        this.job = undefined;
        try {
          hooks.resume();
        } catch (e) {
          this.phase = "failed";
          this.message = errorText(e);
          throw e;
        }
      });
    return this.job;
  }
  private async archive(release: QualifiedCore) {
    const directory = join(
      this.root,
      "runtime-updates",
      "archives",
      release.package.version,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.options.archive)
      return this.options.archive(release, directory, this.controller.signal);
    const spec = release.package,
      destination = join(directory, spec.file);
    if (existsSync(destination)) return destination;
    if (!/^codex-package-[a-zA-Z0-9_-]+\.tar\.gz$/.test(spec.file))
      throw Error("Invalid qualified asset name");
    const temporary = join(directory, `${randomUUID()}.download`);
    const response = await (this.options.fetch ?? fetch)(
      `https://github.com/openai/codex/releases/download/rust-v${spec.version}/${spec.file}`,
      {
        signal: AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(300000),
        ]),
        redirect: "follow",
        headers: { "User-Agent": "Synora-runtime-update" },
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error(`Core download HTTP ${response.status}`);
    }
    const file = await open(temporary, "wx", 0o600),
      reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > spec.size)
          throw Error("Core download exceeds qualified size");
        await file.writeFile(chunk.value);
      }
      await file.sync();
      await file.close();
      if (bytes !== spec.size || (await sha256File(temporary)) !== spec.sha256)
        throw Error("Core download does not match the qualified hash/size");
      await rename(temporary, destination);
      return destination;
    } finally {
      try {
        await reader.cancel();
      } finally {
        try {
          await file.close();
        } finally {
          await rm(temporary, { force: true });
        }
      }
    }
  }
  private async installIdle(version: string, hooks: Hooks) {
    const release = this.lookup(version);
    if (version !== this.snapshot().eligibleVersion)
      throw Error(
        "Choose the currently qualified update; unqualified or stale selection rejected",
      );
    this.lookup(this.state.active.version);
    const archive = await this.archive(release);
    const executable = await installCore(
      archive,
      join(this.root, "runtime-updates", "runtimes"),
      release.package,
    );
    this.checks.push(
      "Qualified archive SHA-256, complete payload and helper integrity verified",
    );
    await this.executable(this.state.active.version); // retain and validate rollback binary
    await hooks.pause();
    this.phase = "snapshotting";
    const id = randomUUID(),
      directory = join(this.root, "runtime-updates", "generations", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const hashes: Record<string, unknown> = {};
    for (const name of ["app-server", "accounts"]) {
      const source = join(this.dataRoot, name);
      if (existsSync(source))
        hashes[name] = await dataTree(source, join(directory, name));
      else {
        await mkdir(join(directory, name), { mode: 0o700 });
        hashes[name] = {};
      }
    }
    const recovery = {
      previous: this.state.active,
      state: hooks.state(),
      hashes,
    };
    await atomicJSON(join(directory, "recovery.json"), recovery);
    this.checks.push(
      "Private, hash-verified copy of all Core homes; previous homes and application state retained",
    );
    this.phase = "validating";
    const probeHome = await mkdtemp(join(directory, "probe-"));
    await (this.options.probe ?? probeCore)(executable, version, probeHome);
    this.checks.push(
      "Native version, isolated initialize, settings and history API checks completed; no inference",
    );
    this.phase = "switching";
    this.controller.signal.throwIfAborted();
    // Persist the signature before selecting the binary, not just a mutable
    // version string. Expiry/withdrawal during download rejects activation.
    if (this.channel?.candidates().some(r => r.package.version === version))
      await this.channel.retain(version);
    else {
      try { (this.options.lookup ?? qualifiedCore)(version); }
      catch { throw Error("Core authorization expired or was withdrawn before activation"); }
    }
    this.message = `App Server ${version} activated. Previous executable and data retained. No active turn was interrupted.`;
    await this.save({
      ...this.state,
      active: { version, generation: id },
      failedAutomaticVersion: null,
      previous: this.state.active,
      recoveryId: id,
      checks: this.checks,
      message: this.message,
    });
    this.phase = "idle";
    this.options.notify?.(this.message);
  }
  private async rollbackIdle(id: string, hooks: Hooks) {
    if (id !== this.state.recoveryId || !this.state.previous)
      throw Error("Stale or missing recovery identity");
    const directory = join(this.root, "runtime-updates", "generations", id);
    const recovery = z
      .object({
        previous: pointerSchema,
        state: z.unknown(),
        hashes: z.record(filesSchema),
      })
      .strict()
      .parse(
        JSON.parse(await readFile(join(directory, "recovery.json"), "utf8")),
      );
    if (
      JSON.stringify(recovery.previous) !== JSON.stringify(this.state.previous)
    )
      throw Error("Recovery identity mismatch");
    await this.executable(recovery.previous.version);
    await hooks.pause();
    const names: ("app-server" | "accounts")[] = [];
    for (const [name, hashes] of Object.entries(recovery.hashes)) {
      if (!["app-server", "accounts"].includes(name))
        throw Error("Unsafe recovery tree");
      if (
        JSON.stringify(await dataTree(join(directory, name))) !==
        JSON.stringify(hashes)
      )
        throw Error(
          "Recovery copy changed since update; refusing destructive recovery",
        );
      names.push(name as "app-server" | "accounts");
    }
    const currentState = hooks.state();
    await atomicJSON(
      join(directory, `before-rollback-${randomUUID()}.json`),
      currentState,
    );
    // Prepare fresh restore copies; immutable originals and newer data are kept.
    const stage = join(directory, "restore-stage");
    if (existsSync(stage))
      throw Error(
        "An unfinished restore stage already exists; inspect recovery before retrying",
      );
    await mkdir(stage, { mode: 0o700 });
    for (const name of names)
      await dataTree(join(directory, name), join(stage, name));
    this.checks.push(
      "Previous binary and unchanged data verified; newer state preserved separately",
    );
    this.message = `Restored App Server ${recovery.previous.version} and its saved session state. Newer data remains in the retained generation.`;
    this.controller.signal.throwIfAborted();
    await this.save({
      ...this.state,
      active: recovery.previous,
      failedAutomaticVersion: this.state.active.version,
      previous: null,
      recoveryId: null,
      restoreState: recovery.state,
      restoreTrees: { id, names },
      checks: this.checks,
      message: this.message,
    });
    this.recoverState(hooks.restore);
    this.phase = "idle";
    this.options.notify?.(this.message);
  }
  async dispose() {
    this.closed = true;
    clearTimeout(this.timer);
    this.controller.abort();
    await Promise.allSettled([this.checkJob, this.job]);
  }
}
