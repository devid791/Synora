// Controlled promises at the real App's typed API boundary; no service or Core.
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import type {
  AppState,
  DesktopAPI,
  EngineSnapshot,
  DesktopEvent,
  Result,
} from "../../src/shared/contracts";

type Call = { method: string; args: unknown[] };
interface Fixture {
  state: AppState;
  snapshot: EngineSnapshot;
  calls: Call[];
  unexpected: string[];
  held: string[];
  holdNextDraft?: boolean;
  holdNextPreferences?: boolean;
  holdNextImage?: boolean;
  holdNextPermission?: boolean;
  imageUrls: Record<string, string>;
  settle: (method: string, error?: string) => void;
  event: (event: DesktopEvent) => void;
}
declare global {
  interface Window {
    enginePending: Fixture;
    enginePendingOptions?: {
      axiom?: boolean;
      connected?: boolean;
      controlStatusError?: boolean;
      panels?: boolean;
      preferences?: Partial<AppState["preferences"]>;
      seed?: Partial<Pick<AppState, "agentHistory" | "delegations" | "conversations">>;
    };
  }
}
const model = {
  id: "offline-model",
  reasoning_efforts: ["low", "high"],
  context_window: 1048576,
  context_window_options: [262144, 1048576],
};
const fixture: Fixture = (window.enginePending = {
  state: {
    version: 1,
    revision: 1,
    engine: { mode: "live", providerId: "offline-provider", model: model.id },
    workspaces: window.enginePendingOptions?.panels
      ? [
          {
            id: "panel-workspace",
            name: "Panel workspace",
            path: "/owned-panel-fixture",
          },
        ]
      : [],
    conversations: [
      {
        id: "offline-conversation",
        title: "Offline pending regression",
        workspaceId: window.enginePendingOptions?.panels
          ? "panel-workspace"
          : null,
        draft: "Retained draft",
        messages: [],
        activity: [],
        itemOrder: [],
        createdAt: 1,
      },
      {
        id: "offline-history",
        title: "Offline restore history",
        workspaceId: null,
        draft: "History draft",
        messages: [],
        activity: [],
        itemOrder: [],
        createdAt: 2,
        binding: {
          threadId: "offline-thread",
          sessionId: "offline-session",
          endpoint: "https://offline-fixture.invalid/v1",
          model: model.id,
          cwd: "/offline-fixture",
        },
      },
    ],
    integrations: [
      {
        id: "offline-provider",
        name: "Offline provider",
        kind: "provider",
        providerType: window.enginePendingOptions?.axiom
          ? "axiom"
          : "compatible",
        enabled: true,
        auth: "none",
        endpoint: "https://offline-fixture.invalid/v1",
        tools: [],
      },
    ],
    presets: [],
    agentHistory: [],
    delegations: [],
    preferences: {
      mode: "default",
      view: "workspace",
      profile: "max",
      context: 1048576,
      compact: false,
      ...window.enginePendingOptions?.preferences,
    },
  },
  snapshot: {
    connection: window.enginePendingOptions?.connected ? "live" : "disconnected",
    conversationId: "offline-conversation",
    threadId: null,
    turnId: null,
    status: "idle",
    sequence: 1,
    items: [],
    agents: [],
    approval: null,
    modelCatalog: [model],
  },
  calls: [],
  unexpected: [],
  held: [],
  imageUrls: {},
  event: () => {},
  settle: () => {
    throw Error("No held operation");
  },
});
if (window.enginePendingOptions?.seed) Object.assign(fixture.state, window.enginePendingOptions.seed);
const releases = new Map<string, (error?: string) => void>();
fixture.settle = (method, error) => {
  const release = releases.get(method);
  if (!release) throw Error(`No held ${method}`);
  release(error);
};
const hold = (method: string) =>
  new Promise<void>((resolve, reject) => {
    if (releases.has(method)) throw Error(`Overlapping ${method}`);
    fixture.held.push(method);
    releases.set(method, (error) => {
      releases.delete(method);
      fixture.held = fixture.held.filter((m) => m !== method);
      if (error) reject(Error(error));
      else resolve();
    });
  });
const ok = <T,>(value: T): Result<T> => ({
  ok: true,
  value: structuredClone(value),
});
const record = (method: string, args: unknown[]) =>
  fixture.calls.push({ method, args: structuredClone(args) });
const listeners = new Set<(event: DesktopEvent) => void>();
fixture.event = event => { for (const callback of listeners) callback(event); };
const implemented = {
  controlStatus: () => {
    if (window.enginePendingOptions?.controlStatusError)
      throw Error("Controlled control-service failure");
    return Promise.resolve(ok({ grant: null, available: { browser: false, computer: false,
      reason: "No computer or browser executor in this controlled fixture" },
      pending: null, activity: [], preview: null }));
  },
  backendStatus: async () =>
    ok({
      mode: "inactive" as const,
      reason: "Controlled fixture has no backend",
    }),
  state: async () => ok(fixture.state),
  capabilities: async () =>
    ok({
      platform: "web" as const,
      transport: "local-http" as const,
      nativeDialogs: false,
      terminal: false,
      embeddedBrowser: false,
      engine: "simulated" as const,
      liveInference: false,
    }),
  engineSnapshot: async () => ok(fixture.snapshot),
  onEvent: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
  browserList: async () => ok([]),
  browserLayout: async () => ok(undefined),
  metrics: async () =>
    ok({
      rssBytes: 0,
      uptimeSeconds: 0,
      terminalCount: 0,
      browserCount: 0,
      gpu: null,
      tokens: null,
      observedAt: 0,
    }),
  coreUpdateStatus: async () =>
    ok({
      currentVersion: "offline",
      latestVersion: null,
      eligibleVersion: null,
      previousVersion: null,
      checkedAt: null,
      automatic: false,
      phase: "idle" as const,
      checking: false,
      message: "Offline fixture",
      checks: [],
      recoveryId: null,
      disabledReason: null,
    }),
  preferences: async (patch) => {
    record("preferences", [patch]);
    if (fixture.holdNextPreferences) {
      fixture.holdNextPreferences = false;
      await hold("preferences");
    }
    fixture.state.preferences = { ...fixture.state.preferences, ...patch };
    fixture.state.revision++;
    return ok(fixture.state);
  },
  newConversation: async (workspaceId) => {
    record("newConversation", [workspaceId]);
    const c = { id: crypto.randomUUID(), title: "New conversation", workspaceId,
      draft: "", messages: [], activity: [], itemOrder: [], createdAt: Date.now() };
    fixture.state.conversations.unshift(c);
    fixture.state.preferences.selectedConversationId = c.id;
    fixture.state.revision++;
    return ok(c);
  },
  chooseWorkspace: async (path) => {
    record("chooseWorkspace", [path]);
    const w = { id: "new-workspace", name: "New QA workspace", path: path ?? "/new-qa" };
    fixture.state.workspaces.push(w);
    fixture.state.revision++;
    return ok(w);
  },
  conversationWorkspace: async (id, workspaceId) => {
    record("conversationWorkspace", [id, workspaceId]);
    const c = fixture.state.conversations.find(c => c.id === id)!;
    if (c.binding && c.workspaceId !== workspaceId)
      return { ok: false, error: { code: "SERVICE_ERROR", message: "A live conversation cannot change workspace. Open a new conversation." } } as const;
    c.workspaceId = workspaceId;
    fixture.state.revision++;
    return ok(fixture.state);
  },
  saveDraft: async (id, draft) => {
    record("saveDraft", [id, draft]);
    if (fixture.holdNextDraft) {
      fixture.holdNextDraft = false;
      await hold("saveDraft");
    }
    fixture.state.conversations.find((c) => c.id === id)!.draft = draft;
    fixture.state.revision++;
    return ok(undefined);
  },
  conversationPermission: async (id, permission) => {
    record("conversationPermission", [id, permission]);
    if (fixture.holdNextPermission) { fixture.holdNextPermission = false; await hold("conversationPermission"); }
    if (id) {
      const c = fixture.state.conversations.find(c => c.id === id)!;
      c.defaults = { bot: c.defaults?.bot ?? null, permission };
    }
    fixture.state.preferences.permission = permission;
    fixture.state.revision++;
    return ok(fixture.state);
  },
  imageAttach: async (id, value) => {
    record("imageAttach", [id, value]);
    if (fixture.holdNextImage) { fixture.holdNextImage = false; await hold("imageAttach"); }
    const c = fixture.state.conversations.find(c => c.id === id)!;
    const image = { id: crypto.randomUUID(), name: value.name, mime: "image/png" as const, bytes: 100, sha256: "1".repeat(64) };
    (c.attachments ??= []).push(image); (c.draftImageIds ??= []).push(image.id);
    fixture.imageUrls[image.id] = value.dataUrl;
    fixture.state.revision++;
    return ok(fixture.state);
  },
  imageRead: async (_id, image) => ok({ dataUrl: fixture.imageUrls[image] }),
  imageRemove: async (id, image) => {
    record("imageRemove", [id, image]);
    const c = fixture.state.conversations.find(c => c.id === id)!;
    c.draftImageIds = c.draftImageIds!.filter(v => v !== image);
    c.attachments = c.attachments!.filter(v => v.id !== image);
    fixture.state.revision++;
    return ok(fixture.state);
  },
  listFiles: async (...args) => {
    record("listFiles", args);
    return ok([
      { path: "owned.txt", name: "owned.txt", directory: false, size: 4 },
    ]);
  },
  readFile: async (...args) => {
    record("readFile", args);
    return ok({
      path: "owned.txt",
      content: "Original",
      revision: "unchanged-file",
    });
  },
  engineModels: async (...args) => {
    record("engineModels", args);
    await hold("engineModels");
    return ok([model]);
  },
  engineConfigure: async (...args) => {
    record("engineConfigure", args);
    await hold("engineConfigure");
    // Preserve exact arguments; no defaulting, normalization or service guard.
    fixture.state.engine = structuredClone(args[0]);
    fixture.state.revision++;
    // A newly configured engine has no restored conversation yet.
    delete fixture.snapshot.conversationId;
    fixture.snapshot.sequence++;
    return ok(fixture.snapshot);
  },
  engineStart: async (...args) => {
    record("engineStart", args);
    fixture.snapshot.sequence++;
    return ok(fixture.snapshot);
  },
  engineRestore: async (...args) => {
    record("engineRestore", args);
    await hold("engineRestore");
    fixture.snapshot.conversationId = args[0];
    fixture.snapshot.sequence++;
    return ok(fixture.snapshot);
  },
} satisfies Partial<DesktopAPI>;
const api = new Proxy(implemented, {
  get(target, key, receiver) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
    return () => {
      fixture.unexpected.push(String(key));
      throw Error(`Offline fixture forbids ${String(key)}`);
    };
  },
}) as unknown as DesktopAPI;
createRoot(document.getElementById("root")!).render(<App api={api} />);
