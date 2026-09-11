import { DatabaseSync } from "node:sqlite";
import { conversationMetadataFields, conversationPatchSchema, conversationTranscript, type ConversationPatch } from "../shared/conversation-management";
import { createHash, randomUUID } from "node:crypto";
import type { AgencyPreview } from "../shared/agency-catalog";
import { templatePreset, templatePresetId } from "../shared/bot-library";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  userPreferenceFields,
  queuedMessageSchema,
} from "../shared/user-preferences";
import { orchestrationPlanSchema } from "../shared/orchestration";
import { delegationTaskSchema } from "../engine/delegation-coordinator";
import { compactionSchema } from "../shared/compaction";
import { sessionUsageSchema } from "../shared/session-usage";
import { permissionModeSchema } from "../shared/permission-mode";
import {
  localCacheKiB,
  localMemoryProfileSchema,
  type LocalMemoryProfile,
} from "../shared/local-memory";
import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { localeSchema } from "../shared/locale";
import { imageAttachmentSchema } from "../shared/image-attachments";
import { validThreadItem } from "../engine/protocol-validation";
import { storedAxiomMetrics } from "../engine/axiom-telemetry";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
import {
  configSchema,
  presetSchema,
  profiles,
  views,
  engineConfigSchema,
  bindingSchema,
  sessionDefaultsSchema,
  type AppState,
  type Workspace,
  type Preset,
} from "../shared/contracts";

function withoutIdentity(p: Preset) {
  const { id: _id, ...value } = p;
  return value;
}
export function manifestHash(value: unknown) {
  const { source: _source, ...manifest } = presetSchema.parse(
    value && typeof value === "object" && "id" in value
      ? withoutIdentity(value as Preset)
      : value,
  );
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
function agencySource(
  preview: AgencyPreview,
  baseHash: string,
): NonNullable<Preset["source"]> {
  return {
    provider: "agency-agents",
    path: preview.entry.path,
    revision: preview.revision,
    blobSha: preview.entry.blobSha,
    sha256: preview.sha256,
    license: "MIT",
    licenseText: preview.licenseText,
    sourceUrl: preview.sourceUrl,
    managed: true,
    updatedAt: Date.now(),
    baseHash,
  };
}

export const preferencesSchema = z
  .object({
    ...userPreferenceFields,
    permission: permissionModeSchema.default("ask"),
    localMemory: localMemoryProfileSchema.default("balanced"),
    locale: localeSchema.default("en"),
    sidebarCollapsed: z.boolean().default(false),
    filesCollapsed: z.boolean().default(false),
    mode: z.enum(["default", "plan"]).default("default"),
    view: z.enum(views),
    profile: z.enum(profiles),
    context: z.union([z.literal(262144), z.literal(1048576)]),
    compact: z.boolean(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    delegations: z.array(delegationTaskSchema).default([]),
    engine: engineConfigSchema.default({
      mode: "simulated",
      providerId: null,
      model: null,
    }),
    workspaces: z.array(
      z.object({ id: z.string(), name: z.string(), path: z.string() }).strict(),
    ),
    conversations: z.array(
      z
        .object({
          id: z.string(),
          ...conversationMetadataFields,
          defaults: sessionDefaultsSchema.optional(),
          queuedMessages: z.array(queuedMessageSchema).max(32).optional(),
          orchestration: orchestrationPlanSchema.optional(),
          title: z.string(),
          workspaceId: z.string().nullable(),
          draft: z.string(),
          compactions: z.array(compactionSchema).default([]),
          usage: sessionUsageSchema.optional(),
          attachments: z.array(imageAttachmentSchema).default([]),
          draftImageIds: z.array(z.string().uuid()).default([]),
          createdAt: z.number(),
          binding: bindingSchema.optional(),
          backendRequests: z.array(storedAxiomMetrics).default([]),
          activity: z
            .array(
              z.custom<ThreadItem>(
                (v) => !!validThreadItem(v),
                "Invalid stored App Server activity",
              ),
            )
            .default([]),
          itemOrder: z.array(z.string()).default([]),
          messages: z.array(
            z
              .object({
                id: z.string(),
                role: z.enum(["user", "assistant"]),
                text: z.string(),
                incomplete: z.boolean().optional(),
                imageIds: z.array(z.string().uuid()).default([]),
                simulated: z.boolean(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    agentHistory: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string(),
            parentId: z.string(),
            coreSessionId: z.string().optional(),
            model: z.string().nullable().optional(),
            profile: z.string().nullable().optional(),
            closed: z.boolean().default(false),
            metadataError: z.string().nullable().optional(),
            turnId: z.string().nullable().optional(),
            startedAt: z.number().nonnegative().optional(),
            completedAt: z.number().nonnegative().optional(),
            activity: z
              .array(
                z.custom<ThreadItem>(
                  (v) => !!validThreadItem(v),
                  "Invalid child activity",
                ),
              )
              .default([]),
            backendRequests: z.array(storedAxiomMetrics).default([]),
            task: z.string(),
            status: z.enum([
              "pendingInit",
              "running",
              "completed",
              "interrupted",
              "errored",
              "shutdown",
              "notFound",
            ]),
            result: z.string(),
            simulated: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    presets: z.array(presetSchema.extend({ id: z.string() })),
    integrations: z.array(configSchema),
    preferences: preferencesSchema,
  })
  .strict();
export function defaultState(): AppState {
  return {
    version: 1,
    engine: { mode: "simulated", providerId: null, model: null },
    revision: 0,
    workspaces: [],
    conversations: [],
    presets: [],
    integrations: [],
    agentHistory: [],
    delegations: [],
    preferences: {
      botCatalogAutomatic: true,
      defaultBotId: null,
      theme: "system",
      busyEnterBehavior: "queue",
      launchAtLogin: false,
      systemNotifications: true,
      mode: "default",
      view: "workspace",
      profile: "ultra-fast",
      context: 262144,
      compact: false,
    },
  };
}
export class Store {
  private cacheKiB = 0;
  private memoryProfile: LocalMemoryProfile = "balanced";
  private db: DatabaseSync;
  private lease: DatabaseSync;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // OS-released SQLite lock: a second service cannot launch Core against the
    // same homes while an update snapshots/restores them. Crash releases it.
    this.lease = new DatabaseSync(`${path}.owner.sqlite`);
    try {
      this.lease.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch {
      this.lease.close();
      throw Error(
        "This Synora data directory is already owned by another service. Use the existing instance or a separate data directory.",
      );
    }
    try {
      this.db = new DatabaseSync(path);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL)",
      );
      this.db
        .prepare("INSERT OR IGNORE INTO state(id,data) VALUES(1,?)")
        .run(JSON.stringify(defaultState()));
      this.applyCache(this.read());
      // Freeze legacy conversations before any preference edit. Existing Core
      // policies win; do not retroactively apply a newly selected Bot.
      const existing = this.read();
      if (
        existing.conversations.some(
          (c) =>
            !c.defaults || c.queuedMessages?.some((m) => m.status !== "held"),
        )
      )
        this.update((s) => {
          for (const c of s.conversations) {
            c.defaults ??= {
              bot: null,
              permission:
                c.binding?.permission ??
                (c.binding ? "ask" : (s.preferences.permission ?? "ask")),
            };
            for (const message of c.queuedMessages ?? [])
              message.status = "held";
          }
        });
    } catch (e) {
      this.lease.close();
      throw e;
    }
  }
  read(): AppState {
    const row = this.db.prepare("SELECT data FROM state WHERE id=1").get() as {
      data: string;
    };
    return stateSchema.parse(JSON.parse(row.data));
  }
  private applyCache(state: AppState) {
    this.memoryProfile = state.preferences.localMemory ?? "balanced";
    const next = localCacheKiB(this.memoryProfile, totalmem());
    if (next === this.cacheKiB) return;
    this.db.exec(`PRAGMA cache_size=-${next}`);
    if (next < this.cacheKiB) this.db.exec("PRAGMA shrink_memory");
    this.cacheKiB = next;
  }
  memoryStatus() {
    const { cache_size } = this.db.prepare("PRAGMA cache_size").get() as {
      cache_size: number;
    };
    return {
      profile: this.memoryProfile,
      cacheTargetBytes: -cache_size * 1024,
      storageDirectory: dirname(this.path),
      physicalMemoryBytes: totalmem(),
      heapUsedBytes: process.memoryUsage().heapUsed,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
    };
  }
  update(fn: (state: AppState) => void): AppState {
    const oldCache = this.cacheKiB;
    const oldProfile = this.memoryProfile;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.read();
      fn(state);
      state.revision++;
      stateSchema.parse(state);
      this.applyCache(state);
      this.db
        .prepare("UPDATE state SET data=? WHERE id=1")
        .run(JSON.stringify(state));
      this.db.exec("COMMIT");
      return state;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.memoryProfile = oldProfile;
      if (oldCache && oldCache !== this.cacheKiB) {
        this.db.exec(`PRAGMA cache_size=-${oldCache}`);
        this.cacheKiB = oldCache;
      }
      throw error;
    }
  }
  preferences(patch: unknown) {
    const parsed = preferencesSchema.partial().parse(patch);
    return this.update((s) => {
      if (
        parsed.defaultBotId &&
        !s.presets.some((p) => p.id === parsed.defaultBotId && p.enabled)
      )
        throw Error("Choose an enabled saved Bot or Synora Standard");
      s.preferences = { ...s.preferences, ...parsed };
    });
  }
  addWorkspace(path: string, name: string): Workspace {
    let result!: Workspace;
    this.update((s) => {
      result = s.workspaces.find((w) => w.path === path) ?? {
        id: randomUUID(),
        path,
        name,
      };
      if (!s.workspaces.some((w) => w.id === result.id))
        s.workspaces.push(result);
    });
    return result;
  }
  /** Explicit composer edit, not a global settings edit. Keep the last Core
   * binding as evidence until resume acknowledges the new policy. */
  conversationPermission(id: string | null, permission: import("../shared/permission-mode").PermissionMode) {
    permissionModeSchema.parse(permission);
    return this.update(s => {
      if (id !== null) {
        const c = s.conversations.find(c => c.id === id);
        if (!c) throw Error("Unknown conversation");
        if (c.queuedMessages?.length) throw Error("Send or discard queued messages before changing permissions");
        c.defaults = { ...c.defaults, bot: c.defaults?.bot ?? null, permission };
      }
      s.preferences.permission = permission;
    });
  }
  conversation(workspaceId: string | null, presetId?: string | null) {
    let result!: AppState["conversations"][number];
    this.update((s) => {
      if (workspaceId && !s.workspaces.some((w) => w.id === workspaceId))
        throw new Error("Unknown workspace");
      const selectedBot =
        presetId === undefined ? s.preferences.defaultBotId : presetId;
      const bot = selectedBot
        ? s.presets.find((p) => p.id === selectedBot && p.enabled)
        : null;
      if (selectedBot && !bot)
        throw Error(
          "The selected Bot is unavailable. Choose an enabled Bot or Synora Standard.",
        );
      result = {
        defaults: {
          permission: s.preferences.permission ?? "ask",
          bot: bot ? structuredClone(bot) : null,
        },
        id: randomUUID(),
        workspaceId,
        title: "New conversation",
        draft: "",
        messages: [],
        activity: [],
        itemOrder: [],
        createdAt: Date.now(),
      };
      s.conversations.unshift(result);
      s.preferences.selectedConversationId = result.id;
    });
    return result;
  }
  draft(id: string, text: string) {
    z.string().max(100000).parse(text);
    this.update((s) => {
      const c = s.conversations.find((c) => c.id === id);
      if (!c) throw new Error("Unknown conversation");
      c.draft = text;
    });
  }
  conversationUpdate(id: string, patch: ConversationPatch) {
    const parsed = conversationPatchSchema.parse(patch);
    return this.update(s => {
      const c = s.conversations.find(c => c.id === id);
      if (!c) throw Error("Unknown conversation");
      if (parsed.projectId && !s.workspaces.some(w => w.id === parsed.projectId)) throw Error("Unknown project");
      Object.assign(c, parsed);
      if (parsed.title !== undefined) c.titleEdited = true;
    });
  }
  conversationForkDraft(id: string) {
    let result!: AppState["conversations"][number];
    this.update(s => {
      const source = s.conversations.find(c => c.id === id);
      if (!source) throw Error("Unknown conversation");
      if (source.messages.some(m => m.incomplete) || source.queuedMessages?.some(m => m.status !== "held"))
        throw Error("Wait for the source conversation to finish before copying its history");
      const draft = conversationTranscript(source);
      if (!draft) throw Error("This conversation has no messages to copy");
      if (draft.length > 100000) throw Error("The transcript exceeds the draft limit. Copy a shorter excerpt into a new conversation.");
      result = {
        id: randomUUID(), title: `${source.title.slice(0, 150)} (fork)`, titleEdited: true,
        workspaceId: source.workspaceId, projectId: source.projectId, forkedFrom: source.id,
        defaults: source.defaults && structuredClone(source.defaults),
        draft, messages: [], activity: [], itemOrder: [], createdAt: Date.now(),
      };
      s.conversations.unshift(result);
    });
    return result;
  }
  conversationDelete(id: string) {
    return this.update(s => {
      const target = s.conversations.find(c => c.id === id);
      if (!target) throw Error("Unknown conversation");
      if (target.queuedMessages?.some(m => m.status !== "held") ||
          s.delegations.some(t => t.parentConversationId === id && ["queued", "running"].includes(t.status)))
        throw Error("Wait for active and queued work before deleting this conversation");
      const owners = new Set([id]);
      if (target.binding && !s.conversations.some(c => c.id !== id && c.binding?.threadId === target.binding!.threadId))
        owners.add(target.binding.threadId);
      for (;;) {
        const previous = owners.size;
        for (const agent of s.agentHistory) if (owners.has(agent.parentId)) {
          if (["pendingInit", "running"].includes(agent.status)) throw Error("Wait for this conversation's agents to finish");
          owners.add(agent.id);
        }
        if (owners.size === previous) break;
      }
      s.conversations = s.conversations.filter(c => c.id !== id);
      s.delegations = s.delegations.filter(t => t.parentConversationId !== id);
      s.agentHistory = s.agentHistory.filter(a => !owners.has(a.id) && !owners.has(a.parentId));
    });
  }
  preset(value: unknown, id?: string) {
    const parsed = presetSchema.parse(value);
    // Only a reviewed catalog import can grant managed provenance. Editing,
    // duplicating or importing JSON creates a local fork, never an auto-update grant.
    if (parsed.source) parsed.source = { ...parsed.source, managed: false };
    return this.update((s) => {
      if (
        s.presets.some(
          (p) =>
            p.name.toLowerCase() === parsed.name.toLowerCase() && p.id !== id,
        )
      )
        throw new Error("A preset with this name already exists");
      if (id && !s.presets.some((p) => p.id === id))
        throw new Error("Unknown preset");
      const p = { ...parsed, id: id ?? randomUUID() };
      s.presets = [...s.presets.filter((v) => v.id !== p.id), p];
      if (!p.enabled && s.preferences.defaultBotId === p.id)
        s.preferences.defaultBotId = null;
    });
  }
  installTemplate(templateId: string) {
    const canonical = templatePreset(templateId),
      id = templatePresetId(templateId);
    const existing = this.read();
    if (existing.presets.some((p) => p.id === id))
      return { state: existing, presetId: id };
    const state = this.update((s) => {
      if (s.presets.some((p) => p.id === id)) return;
      let name = canonical.name,
        number = 2;
      while (s.presets.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        name = `${canonical.name} (${number++})`;
      s.presets.push({ ...presetSchema.parse({ ...canonical, name }), id });
    });
    return { state, presetId: id };
  }
  importAgency(preview: AgencyPreview) {
    const id = `agency-${createHash("sha256").update(preview.entry.path).digest("hex").slice(0, 32)}`;
    const existing = this.read();
    if (existing.presets.some((p) => p.id === id))
      return { state: existing, presetId: id };
    const state = this.update((s) => {
      let name = preview.entry.name.slice(0, 72),
        number = 2;
      const baseName = name;
      while (s.presets.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        name = `${baseName} (${number++})`;
      const value = presetSchema.parse({
        schema: "synora.bot.v1",
        name,
        description: `Agency Agents · ${preview.entry.category}`,
        instructions: preview.instructions,
        kind: ["research", "academic"].includes(preview.entry.category)
          ? "research"
          : "coding",
        profile: "ultra-fast",
        context: 262144,
        connectorIds: [],
        enabled: true,
      });
      s.presets.push({
        ...value,
        id,
        source: agencySource(preview, manifestHash(value)),
      });
    });
    return { state, presetId: id };
  }
  updateAgency(id: string, expectedBaseHash: string, preview: AgencyPreview) {
    let changed = false;
    this.update((s) => {
      const p = s.presets.find((p) => p.id === id);
      // Fetches happen outside the transaction. Recheck ownership and content
      // here so a concurrent edit, deletion or opt-out cannot be overwritten.
      if (
        s.preferences.botCatalogAutomatic === false ||
        !p?.source?.managed ||
        p.source.path !== preview.entry.path ||
        p.source.baseHash !== expectedBaseHash ||
        manifestHash(p) !== expectedBaseHash ||
        p.source.blobSha === preview.entry.blobSha
      )
        return;
      const next = presetSchema.parse({
        ...withoutIdentity(p),
        instructions: preview.instructions,
      });
      next.source = agencySource(preview, manifestHash(next));
      Object.assign(p, next);
      changed = true;
    });
    return changed;
  }
  conversationWorkspace(id: string, workspaceId: string | null) {
    return this.update((s) => {
      const c = s.conversations.find((c) => c.id === id);
      if (!c) throw new Error("Unknown conversation");
      if (c.binding && c.workspaceId !== workspaceId)
        throw new Error(
          "A live conversation cannot change workspace. Open a new conversation.",
        );
      if (workspaceId && !s.workspaces.some((w) => w.id === workspaceId))
        throw new Error("Unknown workspace");
      c.workspaceId = workspaceId;
    });
  }
  integration(value: unknown, originalId?: string) {
    const parsed = configSchema.parse(value);
    return this.update((s) => {
      if (originalId) {
        if (originalId !== parsed.id)
          throw new Error("Configuration IDs are immutable");
        if (!s.integrations.some((i) => i.id === originalId))
          throw new Error("Unknown configuration");
      } else if (s.integrations.some((i) => i.id === parsed.id))
        throw new Error("A configuration with this ID already exists");
      s.integrations = [
        ...s.integrations.filter((v) => v.id !== parsed.id),
        parsed,
      ];
    });
  }
  close() {
    try {
      this.db.close();
    } finally {
      this.lease.close();
    }
  }
  restoreSnapshot(value: unknown) {
    const validated = stateSchema.parse(value);
    this.update((state) => {
      const revision = state.revision;
      Object.assign(state, validated);
      state.revision = revision; // recovery must not rewind local event/state ordering
    });
  }
}
