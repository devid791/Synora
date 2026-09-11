// Real App with a controlled typed service boundary. No Core/model/network IO.
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import { webAPI } from "../../src/renderer/web-api";
import { emptyEngine } from "../../src/renderer/engine-state";
import type {
  AppState,
  DesktopAPI,
  DesktopEvent,
  EngineSnapshot,
  PlatformCapabilities,
  Result,
} from "../../src/shared/contracts";

interface Harness {
  state: AppState;
  calls: Array<{ method: string; args: unknown[] }>;
  unexpected: string[];
  hold: boolean;
  fail: boolean;
  release: (failure?: boolean) => void;
  remount: () => void;
  holdSubmission: boolean;
  failSubmission: boolean;
  releaseSubmission: (failure?: boolean) => void;
  holdDiscard: boolean;
  releaseDiscard: (failure?: boolean) => void;
  updateEngine: (patch: Partial<EngineSnapshot>) => void;
}
declare global {
  interface Window {
    settingsHarness: Harness;
    settingsWebAPI: DesktopAPI;
    settingsOptions?: {
      preferences?: Partial<AppState["preferences"]>;
      platform?: PlatformCapabilities["platform"];
      nativeSupported?: boolean;
      running?: boolean;
    };
  }
}
const bot = {
  schema: "synora.bot.v1" as const,
  name: "Owned <Bot> {identity}",
  description: "CONTROLLED",
  instructions: "KEEP_INSTRUCTIONS",
  kind: "coding" as const,
  profile: "medium" as const,
  context: 262144 as const,
  connectorIds: [],
  enabled: true,
  id: "owned-bot",
};
const harness = (window.settingsHarness = {
  state: {
    version: 1,
    revision: 1,
    engine: {
      mode: "live",
      providerId: "controlled-provider",
      model: "controlled-model",
    },
    workspaces: [],
    integrations: [],
    agentHistory: [],
    delegations: [],
    presets: [
      bot,
      { ...bot, id: "disabled-bot", name: "Disabled bot", enabled: false },
    ],
    conversations: [
      {
        id: "owned-session",
        title: "CONTROLLED session",
        workspaceId: null,
        draft: "KEEP_DRAFT",
        createdAt: 1,
        messages: [],
        activity: [],
        itemOrder: [],
        defaults: { permission: "ask", bot: null },
      },
    ],
    preferences: {
      view: "settings",
      mode: "default",
      profile: "medium",
      context: 262144,
      compact: false,
      ...window.settingsOptions?.preferences,
    },
  } satisfies AppState,
  calls: [],
  unexpected: [],
  hold: false,
  fail: false,
  release: () => {
    throw Error("No pending preference");
  },
  remount: () => {},
  holdSubmission: false,
  failSubmission: false,
  releaseSubmission: () => {
    throw Error("No pending submission");
  },
  updateEngine: () => {},
  holdDiscard: false,
  releaseDiscard: () => {
    throw Error("No pending discard");
  },
} as Harness);
let snapshot: EngineSnapshot = {
  ...emptyEngine,
  conversationId: "owned-session",
  sequence: 1,
};
if (window.settingsOptions?.running) {
  snapshot = {
    ...snapshot,
    status: "running",
    connection: "live",
    threadId: "owned-thread",
    sessionId: "owned-core-session",
    turnId: "owned-turn",
  };
  harness.state.conversations[0].binding = {
    threadId: "owned-thread",
    sessionId: "owned-core-session",
    endpoint: "https://controlled.invalid/v1",
    model: "controlled-model",
    cwd: "/owned-controlled",
    permission: "ask",
  };
}
const listeners = new Set<(e: DesktopEvent) => void>();
const resync = () => {
  for (const listener of listeners) listener({ kind: "resync" });
};
harness.updateEngine = (patch) => {
  snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 };
  resync();
};
const ok = <T,>(value: T): Result<T> => ({
  ok: true,
  value: structuredClone(value),
});
const record = (method: string, args: unknown[]) =>
  harness.calls.push({ method, args: structuredClone(args) });
const implemented = {
  state: async () => ok(harness.state),
  capabilities: async () =>
    ok({
      platform: window.settingsOptions?.platform ?? "web",
      transport:
        window.settingsOptions?.platform &&
        window.settingsOptions.platform !== "web"
          ? "desktop-ipc"
          : "local-http",
      launchAtLogin: {
        supported: window.settingsOptions?.nativeSupported ?? false,
      },
      systemNotifications: {
        supported: window.settingsOptions?.nativeSupported ?? false,
      },
      nativeDialogs: false,
      terminal: false,
      embeddedBrowser: false,
      engine: "live",
      liveInference: false,
    } satisfies PlatformCapabilities),
  engineSnapshot: async () => ok(snapshot),
  onEvent: (listener: (e: DesktopEvent) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  backendStatus: async () =>
    ok({ mode: "inactive" as const, reason: "CONTROLLED fixture" }),
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
      currentVersion: "CONTROLLED",
      latestVersion: null,
      eligibleVersion: null,
      previousVersion: null,
      checkedAt: null,
      automatic: false,
      phase: "idle" as const,
      checking: false,
      message: "CONTROLLED",
      checks: [],
      recoveryId: null,
      disabledReason: null,
    }),
  preferences: async (patch) => {
    record("preferences", [patch]);
    if (harness.hold)
      await new Promise<void>((resolve, reject) => {
        harness.release = (failure) =>
          failure ? reject(Error("CONTROLLED storage failure")) : resolve();
      });
    if (harness.fail)
      return {
        ok: false as const,
        error: { code: "CONTROLLED", message: "CONTROLLED storage failure" },
      };
    harness.state.preferences = { ...harness.state.preferences, ...patch };
    harness.state.revision++;
    return ok(harness.state);
  },
  saveDraft: async (id, text) => {
    record("saveDraft", [id, text]);
    harness.state.conversations.find((c) => c.id === id)!.draft = text;
    return ok(undefined);
  },
  discardQueuedMessage: async (conversationId, messageId) => {
    record("discardQueuedMessage", [conversationId, messageId]);
    if (harness.holdDiscard)
      await new Promise<void>((resolve, reject) => {
        harness.releaseDiscard = (failure) =>
          failure ? reject(Error("CONTROLLED discard failure")) : resolve();
      });
    const c = harness.state.conversations.find((c) => c.id === conversationId);
    const message = c?.queuedMessages?.find((m) => m.id === messageId);
    if (!c || !message || message.status === "dispatching")
      return {
        ok: false as const,
        error: {
          code: "CONTROLLED",
          message: "CONTROLLED message is dispatching",
        },
      };
    c.queuedMessages = c.queuedMessages!.filter((m) => m.id !== messageId);
    harness.state.revision++;
    return ok(harness.state);
  },
  engineStart: async (...args) => {
    record("engineStart", args);
    if (harness.holdSubmission)
      await new Promise<void>((resolve, reject) => {
        harness.releaseSubmission = (failure) =>
          failure ? reject(Error("CONTROLLED stale turn")) : resolve();
      });
    if (harness.failSubmission)
      return {
        ok: false as const,
        error: { code: "STALE", message: "CONTROLLED stale turn" },
      };
    const [id, text, , busy] = args;
    if (busy?.behavior === "queue") {
      const c = harness.state.conversations.find((c) => c.id === id)!;
      (c.queuedMessages ??= []).push({
        id: `00000000-0000-4000-8000-${String(harness.calls.length).padStart(12, "0")}`,
        text,
        threadId: busy.expectedThreadId,
        sessionId: "owned-core-session",
        afterTurnId: busy.expectedTurnId,
        status: "queued",
      });
      harness.state.revision++;
    }
    return ok(snapshot);
  },
  newConversation: async (workspaceId) => {
    record("newConversation", [workspaceId]);
    const pref = harness.state.preferences;
    const c = {
      id: "new-owned-session",
      workspaceId,
      title: "CONTROLLED new session",
      draft: "",
      createdAt: 2,
      messages: [],
      activity: [],
      itemOrder: [],
      defaults: {
        permission: pref.permission ?? "ask",
        bot: pref.defaultBotId ? structuredClone(bot) : null,
      },
    };
    harness.state.conversations.unshift(c);
    harness.state.revision++;
    return ok(c);
  },
} satisfies Partial<DesktopAPI>;
const api = new Proxy(implemented, {
  get(target, key, receiver) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
    return () => {
      harness.unexpected.push(String(key));
      throw Error(`CONTROLLED fixture forbids ${String(key)}`);
    };
  },
}) as unknown as DesktopAPI;
const root = createRoot(document.getElementById("root")!);
window.settingsWebAPI = webAPI();
let generation = 0;
harness.remount = () => root.render(<App key={generation++} api={api} />);
harness.remount();
