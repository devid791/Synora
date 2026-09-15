// Controlled real-App renderer fixture. No Core, model, remote catalog or native services.
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import { noControl } from "./control-status";
import { emptyEngine } from "../../src/renderer/engine-state";
import { templatePreset, templatePresetId } from "../../src/shared/bot-library";
import { presetSchema, type AppState, type BotCatalogUpdateStatus, type DesktopAPI, type DesktopEvent, type EngineSnapshot, type Preset, type Result } from "../../src/shared/contracts";
import { type AgencyCatalogSnapshot, type AgencyPreview, agencySourceUrl } from "../../src/shared/agency-catalog";

type MethodCall = { method: string; args: unknown[] };
interface Harness {
  state: AppState; calls: MethodCall[]; unexpected: string[];
  hold: string | null; fail: string | null; release: (fail?: boolean) => void;
  catalog: AgencyCatalogSnapshot | null; preview: AgencyPreview;
  updates: BotCatalogUpdateStatus; importValue: unknown;
  resync: () => void; remount: () => void;
  updateEngine: (patch: Partial<EngineSnapshot>) => void;
}
declare global {
  interface Window {
    botHarness: Harness;
    botOptions?: { locale?: AppState["preferences"]["locale"]; presets?: Preset[]; running?: boolean; restorePending?: boolean; platform?: "web" | "linux"; view?: "bots" | "workspace"; cached?: boolean; defaultBotId?: string };
  }
}
const options = window.botOptions ?? {};
const entry = { id: "engineering/engineering-evidence.md", path: "engineering/engineering-evidence.md", name: "Agency <Evidence> {name}", category: "engineering" as const, blobSha: "b".repeat(40), bytes: 500 };
const revision = "a".repeat(40);
const preview: AgencyPreview = {
  id: "00000000-0000-4000-8000-000000000001", entry, revision,
  instructions: "EXACT converted instructions\n<script>NO_EXECUTION</script> {name}",
  original: "---\nname: Agency <Evidence> {name}\n---\nORIGINAL English profile",
  sourceUrl: agencySourceUrl(revision, entry.path), sha256: "c".repeat(64),
  licenseText: "MIT License\nCopyright CONTROLLED fixture\nPermission is hereby granted…",
  warnings: ["CONTROLLED warning: review external instructions"],
};
const harness: Harness = window.botHarness = {
  state: {
    version: 1, revision: 1, engine: { mode: "live", providerId: "controlled-provider", model: "controlled-model" },
    workspaces: [{ id: "owned-workspace", name: "CONTROLLED workspace", path: "/controlled/workspace" }],
    integrations: [], agentHistory: [], delegations: [], presets: options.presets ?? [],
    conversations: [{ id: "owned-session", title: "CONTROLLED existing session", workspaceId: "owned-workspace", draft: "KEEP_DRAFT", createdAt: 1, messages: [], activity: [], itemOrder: [], defaults: { permission: "ask", bot: null } }],
    preferences: { view: options.view ?? "bots", mode: "default", profile: "medium", context: 262144, compact: false, locale: options.locale ?? "en", defaultBotId: options.defaultBotId ?? null, botCatalogAutomatic: true },
  },
  calls: [], unexpected: [], hold: options.restorePending ? "engineRestore" : null, fail: null,
  release: () => { throw Error("No pending fixture operation"); },
  catalog: options.cached ? { source: "agency-agents", revision, fetchedAt: 1789050000000, entries: [entry], license: "MIT", excludedCount: 2 } : null,
  preview, updates: { checking: false, lastCheckedAt: null, lastSuccessAt: null, updated: 0, error: null },
  importValue: null, resync: () => {}, remount: () => {}, updateEngine: () => {},
};
let snapshot: EngineSnapshot = { ...emptyEngine, sequence: 1, conversationId: options.restorePending ? undefined : "owned-session", status: options.running ? "running" : "idle" };
if (options.restorePending) harness.state.conversations[0].binding = { threadId: "owned-thread", sessionId: "owned-core-session", endpoint: "https://controlled.invalid/v1", model: "controlled-model", cwd: "/controlled/workspace", permission: "ask" };
const listeners = new Set<(event: DesktopEvent) => void>();
harness.resync = () => { for (const listener of listeners) listener({ kind: "resync" }); };
harness.updateEngine = (patch) => { snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 }; harness.resync(); };
const ok = <T,>(value: T): Result<T> => ({ ok: true, value: structuredClone(value) });
const gate = async (method: string, args: unknown[]) => {
  harness.calls.push({ method, args: structuredClone(args) });
  if (harness.hold === method) await new Promise<void>((resolve, reject) => {
    harness.release = (fail) => { harness.hold = null; fail ? reject(Error(`CONTROLLED ${method} failure`)) : resolve(); };
  });
  if (harness.fail === method) throw Error(`CONTROLLED ${method} failure`);
};
const changed = () => { harness.state.revision++; return ok(harness.state); };
const imported = (): Preset => ({
  ...templatePreset("coding"), id: "agency-owned", name: entry.name, description: `Agency Agents · ${entry.category}`, instructions: preview.instructions,
  source: { provider: "agency-agents", path: entry.path, revision, blobSha: entry.blobSha, sha256: preview.sha256, license: "MIT", licenseText: preview.licenseText, sourceUrl: preview.sourceUrl, managed: true, updatedAt: 1789050000000, baseHash: "d".repeat(64) },
});
const implemented = {
  controlStatus: noControl,
  state: async () => ok(harness.state),
  capabilities: async () => ok({ platform: options.platform ?? "web", transport: options.platform === "linux" ? "desktop-ipc" : "local-http", nativeDialogs: false, terminal: false, embeddedBrowser: false, engine: "live", liveInference: false }),
  engineSnapshot: async () => ok(snapshot),
  engineRestore: async (id) => { await gate("engineRestore", [id]); snapshot = { ...snapshot, conversationId: id, sequence: snapshot.sequence + 1 }; return ok(snapshot); },
  onEvent: (fn: (event: DesktopEvent) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  backendStatus: async () => ok({ mode: "inactive", reason: "CONTROLLED fixture" }),
  browserList: async () => ok([]), browserLayout: async () => ok(undefined), listFiles: async () => ok([]),
  metrics: async () => ok({ rssBytes: 0, uptimeSeconds: 0, terminalCount: 0, browserCount: 0, gpu: null, tokens: null, observedAt: 0 }),
  coreUpdateStatus: async () => ok({ currentVersion: "CONTROLLED", latestVersion: null, eligibleVersion: null, previousVersion: null, checkedAt: null, automatic: false, phase: "idle", checking: false, message: "CONTROLLED", checks: [], recoveryId: null, disabledReason: null }),
  preferences: async (patch) => { await gate("preferences", [patch]); harness.state.preferences = { ...harness.state.preferences, ...patch }; return changed(); },
  saveDraft: async (id, text) => { await gate("saveDraft", [id, text]); harness.state.conversations.find((c) => c.id === id)!.draft = text; harness.state.revision++; return ok(undefined); },
  presetInstallTemplate: async (id) => {
    await gate("presetInstallTemplate", [id]); const presetId = templatePresetId(id);
    if (!harness.state.presets.some((p) => p.id === presetId)) { harness.state.presets.push({ ...templatePreset(id), id: presetId }); harness.state.revision++; }
    return ok({ state: harness.state, presetId });
  },
  presetSave: async (value, id) => {
    await gate("presetSave", [value, id]); const parsed = presetSchema.parse(value);
    if (harness.state.presets.some((p) => p.id !== id && p.name.toLowerCase() === parsed.name.toLowerCase())) throw Error("CONTROLLED duplicate name");
    if (parsed.source) parsed.source.managed = false;
    harness.state.presets = [...harness.state.presets.filter((p) => p.id !== id), { ...parsed, id: id ?? `created-${harness.state.revision}` }]; return changed();
  },
  presetDelete: async (id) => { await gate("presetDelete", [id]); harness.state.presets = harness.state.presets.filter((p) => p.id !== id); if (harness.state.preferences.defaultBotId === id) harness.state.preferences.defaultBotId = null; return changed(); },
  presetExport: async (id) => { await gate("presetExport", [id]); return ok(true); },
  presetImport: async () => { await gate("presetImport", []); if (harness.importValue === null) return ok(null); const value = presetSchema.parse(harness.importValue); if (value.source) value.source.managed = false; harness.state.presets.push({ ...value, id: `json-${harness.state.revision}` }); return changed(); },
  newConversation: async (workspaceId, presetId) => {
    await gate("newConversation", [workspaceId, presetId]);
    const id = presetId === undefined ? harness.state.preferences.defaultBotId : presetId;
    const bot = id ? harness.state.presets.find((p) => p.id === id) : null;
    if (id && !bot?.enabled) throw Error("CONTROLLED missing/disabled bot");
    const c = { id: `new-session-${harness.state.revision}`, title: "CONTROLLED new session", workspaceId, draft: "", createdAt: 2, messages: [], activity: [], itemOrder: [], defaults: { permission: harness.state.preferences.permission ?? "ask", bot: structuredClone(bot ?? null) } };
    harness.state.conversations.unshift(c); harness.state.revision++; return ok(c);
  },
  botCatalogRead: async (refresh) => { await gate("botCatalogRead", [refresh]); return ok(harness.catalog); },
  botCatalogUpdates: async () => { await gate("botCatalogUpdates", []); return ok(harness.updates); },
  botCatalogPreview: async (...args) => { await gate("botCatalogPreview", args); return ok(harness.preview); },
  botCatalogImport: async (...args) => { await gate("botCatalogImport", args); const p = imported(); if (!harness.state.presets.some((saved) => saved.id === p.id)) harness.state.presets.push(p); harness.state.revision++; return ok({ state: harness.state, presetId: p.id }); },
} satisfies Partial<DesktopAPI>;
const api = new Proxy(implemented, { get(target, key, receiver) {
  if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
  return () => { harness.unexpected.push(String(key)); throw Error(`CONTROLLED fixture forbids ${String(key)}`); };
} }) as unknown as DesktopAPI;
const root = createRoot(document.getElementById("root")!);
let generation = 0;
harness.remount = () => root.render(<App key={generation++} api={api} />);
harness.remount();
