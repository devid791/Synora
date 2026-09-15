import { integrationServerName } from "../shared/integration-runtime";
import { AppServerConnection } from "./AppServerConnection";
import { useI18n, setLocale, localeNames, type Messages } from "./i18n";
import { messages } from "./locales/app";
import {
  providerDefinitions,
  providerRuntimeLabel,
  providerUsesCoreModel,
  type MountedProviderType,
} from "../shared/provider-registry";
import { ProviderLogin } from "./ProviderLogin";
import { GoogleAccount } from "./GoogleAccount";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Bot,
  Boxes,
  ChevronLeft,
  ChevronRight,
  File,
  FolderOpen,
  Globe,
  LayoutDashboard,
  Network,
  Plus,
  Plug,
  Puzzle,
  RefreshCw,
  Save,
  Settings,
  SquareTerminal,
  X,
  ArrowUp,
  Square,
  PanelLeftClose,
  PanelLeftOpen,
  FolderTree,
} from "lucide-react";
import {
  profiles,
  scenarios,
  PROTOCOL_VERSION,
  type AppState,
  type BrowserTab,
  type DesktopAPI,
  type EngineSnapshot,
  type FileDocument,
  type FileEntry,
  type Integration,
  type LocalMetrics,
  type PlatformCapabilities,
  type Result,
  type Scenario,
  type View,
} from "../shared/contracts";
import { emptyEngine, reduceEngine } from "./engine-state";
import { RemoteBrowser } from "./RemoteBrowser";
import { ComputerControl } from "./ComputerControl";
import { ComposerHistory } from "./composer-history";
import { Modal } from "./Modal";
import { BotLibrary, type BotSelection } from "./BotLibrary";
import { messages as botMessages } from "./locales/bots";
import { EngineSettings } from "./EngineSettings";
import { OrchestrationPanel } from "./OrchestrationPanel";
import { CoreUpdateSettings } from "./CoreUpdateSettings";
import { McpSignIn } from "./McpSignIn";
import { CoreCatalog } from "./CoreCatalog";
import { PluginDirectory } from "./PluginDirectory";
import { commandDecisionAllowed } from "../shared/core-compatibility";
import { ProviderToken } from "./ProviderToken";
import { CompatibleSettingsEditor } from "./CompatibleSettings";
import { CoreAccount } from "./CoreAccount";
import { ProviderDirectory } from "./ProviderDirectory";
import { WorkspaceModelPicker } from "./WorkspaceModelPicker";
import { StatusBar } from "./StatusBar";
import { ContextUsage } from "./ContextUsage";
import { ComposerAdd } from "./ComposerAdd";
import { PermissionPicker } from "./PermissionPicker";
import { LocalMemorySettings } from "./LocalMemorySettings";
import { GeneralSettings } from "./GeneralSettings";
import { BusyMessageStatus } from "./BusyMessageStatus";
import { useSettingsPreferences } from "./settings-preferences";
import { useSettingsTheme } from "./settings-theme";
import { busyEnterBehavior } from "./settings-send";
import { providerPreset } from "../shared/provider-onboarding";
import { ToolActivity } from "./ToolActivity";
import { MessageText } from "./MessageText";
import { UserQuestion } from "./UserQuestion";
import { AxiomTelemetry } from "./AxiomTelemetry";
import { ResourceTelemetry } from "./ResourceTelemetry";
import { AgentCard } from "./AgentCard";
import { conversationTimeline } from "./conversation-timeline";
import { ConversationSidebar } from "./ConversationSidebar";
import { ConversationStarters } from "./ConversationStarters";
import { ConversationSplit, RelatedSideTabs, SplitToggle, useConversationSplit } from "./ConversationSplit";
import type { SideTarget } from "./split-view-state";
import { AttachedImage, ImageInput, transferredFiles, useImageUpload } from "./Images";
import { version as applicationVersion } from "../../package.json";
const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((module) => ({
    default: module.TerminalPanel,
  })),
);

const nav: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: "workspace", label: "Workspace", icon: LayoutDashboard },
  { id: "agents", label: "Agents", icon: Network },
  { id: "bots", label: "Bots", icon: Bot },
  { id: "browser", label: "Browser", icon: Globe },
  { id: "models", label: "Models & accounts", icon: Boxes },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "plugins", label: "Plugins & MCP", icon: Puzzle },
  { id: "telemetry", label: "Telemetry & backend", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];
const unwrap = <T,>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
export function App({ api }: { api: DesktopAPI }) {
  const { t, locale, number } = useI18n(messages satisfies Messages);
  const { t: botText } = useI18n(botMessages);
  const mb = (n: number) => `${number(Math.round(n / 1024 / 1024 * 10) / 10)} MB`;
  const [localePending, setLocalePending] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentWrite = useRef<Promise<void> | null>(null);
  const [busySubmissionPending, setBusySubmissionPending] = useState(false);
  const [busySubmissionReceipt, setBusySubmissionReceipt] = useState<{
    conversationId: string; threadId: string; turnId: string; behavior: "queue" | "steer";
  } | null>(null);
  const busySubmissionWrite = useRef<Promise<void> | null>(null);
  const queueRemovalWrite = useRef<Promise<void> | null>(null);
  const [queueRemoval, setQueueRemoval] = useState<{ conversationId: string; messageId: string } | null>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const composerHistory = useRef(new ComposerHistory());
  const [providerAuthRevision, setProviderAuthRevision] = useState(0);
  const providerAuthorized = useCallback(
    () => setProviderAuthRevision((v) => v + 1),
    [],
  );
  const [state, setState] = useState<AppState | null>(null),
    [caps, setCaps] = useState<PlatformCapabilities | null>(null),
    [engine, setEngine] = useState(emptyEngine),
    [metrics, setMetrics] = useState<LocalMetrics | null>(null);
  const split = useConversationSplit(state, engine);
  const inspectBeside = (target: SideTarget) => {
    split.open(target);
    void selectView("workspace");
  };
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conversation, setConversation] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [draft, setDraft] = useState(""),
    [scenario, setScenario] = useState<Scenario>("text");
  const [composerFocusId, setComposerFocusId] = useState<string | null>(null);
  const latestComposer = useRef({ conversation, draft });
  latestComposer.current = { conversation, draft };
  const [terminal, setTerminal] = useState(false),
    [files, setFiles] = useState<FileEntry[]>([]),
    [directory, setDirectory] = useState(""),
    [document, setDocument] = useState<FileDocument | null>(null),
    [edited, setEdited] = useState("");
  const [tabs, setTabs] = useState<BrowserTab[]>([]),
    [tab, setTab] = useState(""),
    [url, setURL] = useState(""),
    [integration, setIntegration] = useState<Integration | null>(null);
  const [integrationId, setIntegrationId] = useState<string | undefined>(),
    [workspacePrompt, setWorkspacePrompt] = useState<string | null>(null);
  const [pendingCompact, setPendingCompact] = useState<boolean | null>(null);
  const [panelPending, setPanelPending] = useState(false);
  useEffect(() => {
    setLocale(state?.preferences.locale ?? "en");
  }, [state?.preferences.locale]);
  const resolvedTheme = useSettingsTheme(state?.preferences.theme);
  const brandSource = resolvedTheme === "light" ? "./brand/synora-light.svg" : "./brand/synora.svg";
  const [enginePending, setEnginePending] = useState("");
  const [restoreFailed, setRestoreFailed] = useState<string | null>(null);
  const [restoreRequest, setRestoreRequest] = useState(0);
  const engineOperation = useRef<symbol | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [conversationOverlay, setConversationOverlay] = useState(false);
  const [telemetryOverlay, setTelemetryOverlay] = useState(false);
  const [controlPanelOpen, setControlPanelOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const resized = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resized);
    return () => window.removeEventListener("resize", resized);
  }, []);
  const compactControl = controlPanelOpen && viewportWidth <= 1100;
  const overlayOpen = !!integration || workspacePrompt !== null || conversationOverlay || telemetryOverlay || controlPanelOpen;
  const preferenceWrite = useRef<Promise<void> | null>(null);
  const conversationWrite = useRef<Promise<void> | null>(null);
  const draftWrite = useRef<Promise<unknown> | null>(null);
  const browserRect = useRef<HTMLDivElement>(null),
    draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    draftPending = useRef<{ id: string; text: string } | null>(null),
    scroll = useRef<HTMLDivElement>(null);
  const prepareClose = useRef<(id: string) => Promise<void>>(async () => {});
  const beforeWebClose = useRef<(event: BeforeUnloadEvent) => void>(() => {});
  useEffect(() => {
    if (caps?.platform !== "web") return;
    const close = (event: BeforeUnloadEvent) => beforeWebClose.current(event);
    window.addEventListener("beforeunload", close);
    return () => window.removeEventListener("beforeunload", close);
  }, [caps?.platform]);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const acceptState = useCallback(
    (s: AppState) =>
      setState((old) => (!old || s.revision >= old.revision ? s : old)),
    [],
  );
  const generalPreferences = useSettingsPreferences(api, acceptState, preferenceWrite);
  const refresh = useCallback(
    () => api.state().then(unwrap).then(acceptState),
    [api],
  );
  const snapshot = useCallback(
    (s: EngineSnapshot) =>
      setEngine((old) => (s.sequence >= old.sequence ? s : old)),
    [],
  );
  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      report(e);
    }
  };
  // Owned by App, not the Settings view: navigation must not release the gate.
  // The ref admits operations synchronously, including before React repaints.
  const runEngineOperation = useCallback(
    async (
      operation: () => Promise<void>,
      label = "Applying engine configuration…",
    ) => {
      if (attachmentWrite.current) throw Error(t("Wait for the image upload to finish"));
      if (engineOperation.current)
        throw Error(t("Wait for the current engine operation to finish"));
      const owner = Symbol();
      engineOperation.current = owner;
      setEnginePending(label);
      setError("");
      try {
        await operation();
      } catch (e) {
        if (mounted.current) report(e);
        throw e;
      } finally {
        if (engineOperation.current === owner) {
          engineOperation.current = null;
          if (mounted.current) setEnginePending("");
        }
      }
    },
    [report, t],
  );
  useEffect(() => {
    const off = api.onEvent((event) => {
      if (event.kind === "delegations") {
        setState((s) =>
          s && event.revision >= s.revision
            ? { ...s, delegations: event.tasks, revision: event.revision }
            : s,
        );
      } else if (event.kind === "engine") {
        setEngine((s) => reduceEngine(s, event.data));
        const e = event.data.event;
        if (
          e.kind === "agents" ||
          (e.kind === "protocol" && e.payload.method === "turn/completed")
        )
          void refresh().catch(report);
      } else if (event.kind === "resync") {
        void Promise.all([
          refresh(),
          api
            .engineSnapshot()
            .then(unwrap)
            .then((s) => setEngine(s)),
          api.browserList().then(unwrap).then(setTabs),
        ]).catch(report);
      } else if (event.kind === "browser") setTabs(event.tabs);
      else if (event.kind === "notice") setNotice(event.message);
      else if (event.kind === "prepare-close")
        void prepareClose.current(event.id).catch(report);
    });
    const initialize = async () => {
      let s = unwrap(await api.state());
      if (!s.conversations.length) {
        unwrap(await api.newConversation(null));
        s = unwrap(await api.state());
      }
      acceptState(s);
    };
    void Promise.all([
      initialize(),
      api.capabilities().then(unwrap).then(setCaps),
      api.engineSnapshot().then(unwrap).then(snapshot),
      api.browserList().then(unwrap).then(setTabs),
    ]).catch(report);
    let active = true, metricsPending = false;
    const poll = async () => {
      if (metricsPending || !active) return;
      metricsPending = true;
      try {
        const m = unwrap(await api.metrics());
        if (active) setMetrics(m);
      } catch (e) {
        if (active) report(e);
      } finally {
        metricsPending = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (globalThis.document.visibilityState === "visible") void poll();
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
      off();
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);
  const current = state?.conversations.find((c) => c.id === conversation),
    view = state?.preferences.view ?? "workspace",
    busy =
      ["running", "waiting"].includes(engine.status) || !!engine.cleanupPending,
    engineControlsBusy = busy || !!enginePending || busySubmissionPending;
  useEffect(() => {
    // A frame can run before React commits a route change (notably when leaving
    // the native Browser). Focus the requested chat's actual committed input.
    if (composerFocusId && view === "workspace" &&
        conversation === composerFocusId && current?.id === composerFocusId &&
        composerInput.current) {
      composerInput.current.focus({ preventScroll: true });
      setComposerFocusId(null);
    }
  }, [composerFocusId, conversation, current?.id, view]);
  const botUseBusy = useRef(false);
  botUseBusy.current = busy || busySubmissionPending;
  const restoring = useRef<string | null>(null);
  useEffect(() => {
    if (restoring.current !== conversation) restoring.current = null;
    if (
      state?.engine.mode !== "live" ||
      !current?.binding ||
      busy ||
      engineOperation.current ||
      conversationWrite.current ||
      engine.conversationId === conversation ||
      restoring.current === conversation
    )
      return;
    restoring.current = conversation;
    // Keep the attempt identity after failure: settling the gate is not a retry.
    void runEngineOperation(async () => {
      snapshot(unwrap(await api.engineRestore(conversation)));
      await refresh();
      if (restoring.current === conversation) restoring.current = null;
      if (mounted.current) setRestoreFailed(null);
    }, "Restoring the selected conversation…").catch((e) => {
      if (mounted.current) setRestoreFailed(conversation);
      report(e);
    });
  }, [
    conversation,
    current?.binding?.threadId,
    state?.engine.mode,
    busy,
    enginePending,
    restoreRequest,
  ]);
  const flushDraft = async () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    // A debounce may already have taken the pending draft. Sending/switching
    // must still await that write; null pending does not mean persistence ended.
    if (draftWrite.current) await draftWrite.current;
    const pending = draftPending.current;
    if (!pending) return;
    draftPending.current = null;
    const write = api.saveDraft(pending.id, pending.text).then(unwrap);
    draftWrite.current = write;
    try {
      await write;
    } catch (e) {
      if (!draftPending.current) draftPending.current = pending;
      throw e;
    } finally {
      if (draftWrite.current === write) draftWrite.current = null;
    }
    if (draftPending.current) await flushDraft();
  };
  prepareClose.current = async (id) => {
    await preferenceWrite.current;
    await conversationWrite.current;
    await busySubmissionWrite.current;
    await queueRemovalWrite.current;
    await attachmentWrite.current;
    await flushDraft();
    unwrap(await api.closeReady(id, !!document && edited !== document.content));
  };
  beforeWebClose.current = (event) => {
    const pending =
      !!draftPending.current ||
      !!draftWrite.current ||
      !!busySubmissionWrite.current ||
      !!queueRemovalWrite.current ||
      !!preferenceWrite.current;
    const conversationPending = !!conversationWrite.current || !!attachmentWrite.current;
    void flushDraft().catch(report);
    if (pending || conversationPending || (document && edited !== document.content)) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  const ensureCleanEditor = () => {
    if (attachmentWrite.current) throw Error(t("Wait for the image upload to finish"));
    if (document && edited !== document.content)
      throw new Error(
        t("Save or reload your file before switching workspaces or conversations."),
      );
  };
  const selectConversation = async (id: string) => {
    ensureCleanEditor();
    setComposerFocusId(null);
    await flushDraft();
    let s = unwrap(await api.state());
    if (s.conversations.find(c => c.id === id)?.unread) s = unwrap(await api.conversationUpdate(id, { unread: false }));
    if (!s.conversations.some(c => c.id === id)) throw Error("Unknown conversation");
    if (s.preferences.selectedConversationId !== id)
      s = unwrap(await api.preferences({ selectedConversationId: id }));
    acceptState(s);
    const c = s.conversations.find((c) => c.id === id);
    setConversation(id);
    setDraft(c?.draft ?? "");
    setWorkspace(c?.workspaceId ?? "");
    setDirectory("");
  };
  useEffect(() => {
    if (state && !conversation && state.conversations[0]) {
      const c = state.conversations.find(c => c.id === state.preferences.selectedConversationId && !c.archived)
        ?? state.conversations.find(c => !c.archived) ?? state.conversations[0];
      setConversation(c.id);
      setDraft(c.draft);
      setWorkspace(c.workspaceId ?? "");
    }
  }, [state, conversation]);
  const selectView = (value: View) =>
    run(async () => {
      setComposerFocusId(null);
      await flushDraft();
      acceptState(unwrap(await api.preferences({ view: value })));
    });
  const togglePanel = (key: "sidebarCollapsed" | "filesCollapsed") => {
    if (preferenceWrite.current || !state) return;
    // Small-screen browser docking temporarily frees navigation space, without
    // overwriting the user's saved layout. Opening navigation restores it.
    if (compactControl) {
      setControlPanelOpen(false);
      if (!state.preferences[key]) return;
    }
    setPanelPending(true);
    // A layout preference never reconfigures Core or selects a conversation.
    // Await the real persisted state; failure leaves the current layout intact.
    preferenceWrite.current = run(async () => {
      try {
        acceptState(unwrap(await api.preferences({ [key]: !state.preferences[key] })));
      } finally {
        setPanelPending(false);
        preferenceWrite.current = null;
      }
    });
  };
  const selectWorkspace = async (id: string) => {
    ensureCleanEditor();
    if (conversation)
      acceptState(
        unwrap(await api.conversationWorkspace(conversation, id || null)),
      );
    setWorkspace(id);
    setDirectory("");
  };
  const addWorkspace = async (path?: string) => {
    ensureCleanEditor();
    const w = unwrap(await api.chooseWorkspace(path));
    if (w) {
      // Registration succeeded even if an existing live chat cannot be rebound.
      // Show the new workspace before the immutable-binding guard can reject it.
      await refresh();
      await selectWorkspace(w.id);
    }
  };
  const reloadFiles = async () => {
    if (!workspace) {
      setFiles([]);
      return;
    }
    setFiles(unwrap(await api.listFiles(workspace, directory)));
  };
  useEffect(() => {
    setDocument(null);
    setEdited("");
    void run(reloadFiles);
  }, [workspace, directory]);
  useEffect(() => {
    scroll.current?.scrollTo({
      top: scroll.current.querySelector(".welcome") ? 0 : scroll.current.scrollHeight,
      behavior: scroll.current.querySelector(".welcome") ? "instant" : "smooth",
    });
  }, [engine.items, current?.messages.length]);
  useEffect(() => {
    if (view !== "browser" || !tab || !browserRect.current || overlayOpen) {
      void api.browserLayout(null, { x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    const element = browserRect.current;
    const layout = () => {
      const r = element.getBoundingClientRect();
      void api
        .browserLayout(tab, {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        })
        .then(unwrap)
        .catch(report);
    };
    const observer = new ResizeObserver(layout);
    observer.observe(element);
    window.addEventListener("resize", layout);
    layout();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", layout);
      void api.browserLayout(null, { x: 0, y: 0, width: 0, height: 0 });
    };
  }, [view, tab, notice, error, overlayOpen]);
  const newConversation = () =>
    run(async () => {
      ensureCleanEditor();
      await flushDraft();
      const c = unwrap(await api.newConversation(workspace || null));
      setConversation(c.id);
      setDraft("");
      await refresh();
      acceptState(unwrap(await api.preferences({ view: "workspace" })));
      setComposerFocusId(c.id);
    });
  const useBot = async (selection: BotSelection) => {
    if (engineOperation.current || botUseBusy.current)
      throw Error(t("Wait for the current engine operation to finish"));
    await runEngineOperation(async () => {
      ensureCleanEditor();
      await flushDraft();
      if (botUseBusy.current) throw Error(t("Wait for the current engine operation to finish"));
      let presetId: string | null;
      if ("templateId" in selection) {
        const installed = unwrap(await api.presetInstallTemplate(selection.templateId));
        acceptState(installed.state);
        presetId = installed.presetId;
      } else presetId = selection.presetId;
      if (botUseBusy.current) throw Error(t("Wait for the current engine operation to finish"));
      const c = unwrap(await api.newConversation(workspace || null, presetId));
      setConversation(c.id);
      setDraft(c.draft);
      await refresh();
      acceptState(unwrap(await api.preferences({ view: "workspace" })));
    }, botText("Opening bot conversation…"));
  };
  const send = () =>
    run(async () => {
      if (engineOperation.current) return;
      if (attachmentWrite.current) throw Error(t("Wait for the image upload to finish"));
      await flushDraft();
      if (engineOperation.current) return;
      let id = conversation;
      if (!id) {
        id = unwrap(await api.newConversation(workspace || null)).id;
        setConversation(id);
      }
      if (engineOperation.current) return;
      const started = unwrap(await api.engineStart(id, draft, scenario));
      snapshot(started);
      if (started.status !== "interrupted") setDraft("");
      await refresh();
    });
  const changeDraft = (text: string, recalled = false) => {
    if (!recalled) composerHistory.current.reset();
    setDraft(text);
    if (!conversation) return;
    draftPending.current = { id: conversation, text };
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => void flushDraft().catch(report), 200);
  };
  const timeline = conversationTimeline(current, engine);
  const live = state?.engine.mode === "live";
  const uploadImages = useImageUpload({
    api, pending: attachmentWrite, busy: !live || engineControlsBusy || !!conversationWrite.current,
    setBusy: setAttachmentBusy, updated: acceptState, failed: report,
    ensureConversation: async () => {
      await flushDraft();
      if (conversation) return conversation;
      const c = unwrap(await api.newConversation(workspace || null));
      setConversation(c.id);
      // A first pasted image must not discard text typed before a chat exists.
      unwrap(await api.saveDraft(c.id, latestComposer.current.draft));
      await refresh();
      return c.id;
    },
  });
  const applyWorkspaceModel = async (
    config: import("../shared/contracts").EngineConfig,
  ) => {
    await runEngineOperation(async () => {
      ensureCleanEditor();
      await flushDraft();
      const changed =
        config.providerId !== state?.engine.providerId ||
        config.model !== state?.engine.model;
      snapshot(unwrap(await api.engineConfigure(config)));
      if (changed) {
        const c = unwrap(await api.newConversation(workspace || null));
        setConversation(c.id);
        // The previous draft is already persisted on its original conversation.
        setDraft("");
      }
      await refresh();
      setCaps(unwrap(await api.capabilities()));
    });
  };
  const activeConversation =
    (engine.conversationId ?? engine.threadId) === conversation;
  const busySubmissionAvailable = !!(live && activeConversation && current?.binding &&
    engine.connection === "live" && ["running", "waiting"].includes(engine.status) &&
    !engine.cleanupPending && !enginePending && !attachmentBusy &&
    !current.draftImageIds?.length && engine.threadId && engine.turnId &&
    engine.sessionId === current.binding.sessionId && engine.threadId === current.binding.threadId);
  const submitBusyMessage = (action: boolean | "queue" | "steer" = false) => {
    if (!busySubmissionAvailable || busySubmissionWrite.current || engineOperation.current || !draft.trim()) return;
    const id = conversation, text = draft;
    const expected = {
      behavior: typeof action === "boolean" ? busyEnterBehavior(state?.preferences.busyEnterBehavior, action) : action,
      expectedThreadId: engine.threadId!, expectedTurnId: engine.turnId!,
    };
    setBusySubmissionPending(true);
    setBusySubmissionReceipt(null);
    const write = run(async () => {
      await flushDraft();
      if (engineOperation.current) return;
      const result = unwrap(await api.engineStart(id, text, "text", expected));
      snapshot(result);
      setBusySubmissionReceipt({ conversationId: id, threadId: expected.expectedThreadId,
        turnId: expected.expectedTurnId, behavior: expected.behavior });
      // Typing or navigating during an acknowledgement must not lose a newer draft.
      if (latestComposer.current.conversation === id && latestComposer.current.draft === text) {
        changeDraft("");
        await flushDraft();
      }
      await refresh();
    });
    busySubmissionWrite.current = write;
    void write.finally(() => {
      if (busySubmissionWrite.current === write) busySubmissionWrite.current = null;
      setBusySubmissionPending(false);
    });
  };
  const removeQueuedMessage = async (messageId: string) => {
    if (queueRemovalWrite.current || !current) return;
    const message = current.queuedMessages?.find((m) => m.id === messageId);
    if (!message || message.status === "dispatching") return;
    setQueueRemoval({ conversationId: conversation, messageId });
    setError("");
    const write = (async () => {
      acceptState(unwrap(await api.discardQueuedMessage(conversation, messageId)));
    })();
    queueRemovalWrite.current = write;
    try { await write; }
    catch (e) { report(e); throw e; }
    finally {
      if (queueRemovalWrite.current === write) queueRemovalWrite.current = null;
      setQueueRemoval(null);
    }
  };
  // Per-conversation counters must not leak from another globally active turn.
  const conversationEngine: EngineSnapshot = activeConversation ? engine : {
    ...emptyEngine,
    connection: engine.connection,
    agents: engine.agents,
    conversationId: current?.id,
    usage: current?.usage,
    tokenUsage: current?.usage?.value,
    compactions: current?.compactions,
    backendRequests: current?.backendRequests,
    status: "idle",
  };
  if (!state)
    return (
      <main className="boot">
        <img src={brandSource} alt="Synora" />
        <p>{error || t("Opening your local workspace…")}</p>
      </main>
    );
  const pref = state.preferences;
  const sidebarCollapsed = compactControl || !!pref.sidebarCollapsed;
  const filesCollapsed = compactControl || !!pref.filesCollapsed;
  const selectedProvider = state.integrations.find(
    (p) => p.id === state.engine.providerId,
  );
  const selectedProviderType = selectedProvider?.providerType;
  const openAi = live && providerUsesCoreModel(selectedProviderType);
  const providerLabel = providerRuntimeLabel(selectedProviderType);
  const selectedCoreModel = openAi
    ? engine.modelCatalog?.find((m) => m.id === state.engine.model)
    : undefined;
  const configView = (kind: Integration["kind"], title: string) => (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">{t("CAPABILITY REGISTRY")}</p>
          <h1>{title}</h1>
          <p>
            {t("Executor-backed integrations are mounted by App Server when a live session starts or resumes. Runtime status below comes from Core, not from saved configuration.")}</p>
        </div>
        <button
          onClick={() => {
            setIntegrationId(undefined);
            setIntegration({
              id: "",
              name: "",
              kind,
              endpoint: "",
              enabled: false,
              auth: "none",
              tools: [],
            });
          }}
        >
          <Plus />
          {t("Add configuration")}</button>
      </div>
      {kind === "provider" && (
        <ProviderDirectory
          providers={state.integrations}
          busy={engineControlsBusy}
          choose={(type) => {
            setIntegrationId(undefined);
            setIntegration(providerPreset(type, state.integrations));
          }}
        />
      )}
      <div className="cards">
        {kind === "provider" && (
          <CoreAccount
            api={api}
            busy={engineControlsBusy}
            web={caps?.transport === "local-http"}
          />
        )}
        {kind === "mcp" && (
          <McpSignIn
            api={api}
            state={state}
            busy={engineControlsBusy}
            web={caps?.transport === "local-http"}
          />
        )}
        {state.integrations
          .filter((i) => i.kind === kind)
          .map((i) => {
            const server =
              engine.connection === "live"
                ? engine.mcpServers?.find(
                    (s) => s.name === integrationServerName(i.id),
                  )
                : undefined;
            const mounted =
              server?.runtimeStatus === "connected"
                ? Object.values(server.tools).filter(Boolean)
                : [];
            return (
              <article className="card" key={i.id}>
                <div className="card-title">
                  <strong>{i.name}</strong>
                  <span className="badge">
                    {!i.enabled
                      ? t("Disabled")
                      : i.kind === "provider"
                        ? live && state.engine.providerId === i.id
                          ? engine.connection === "live"
                            ? t("Core connected")
                            : t("Selected · Core idle")
                          : t("Configured")
                        : (server?.runtimeStatus ?? t("Not connected"))}
                  </span>
                </div>
                <p className="mono">{i.endpoint || t("No endpoint configured")}</p>
                <p>
                  {i.auth === "core-account"
                    ? t("Original Core account · see OpenAI / ChatGPT sign-in")
                    : i.auth === "oauth"
                      ? i.providerType === "gemini"
                        ? t("Google OAuth · see browser sign-in")
                        : i.executor === "http-mcp"
                          ? t("Core-managed OAuth · see browser sign-in")
                          : t("OAuth not mounted for this executor")
                      : i.auth === "api-key"
                        ? i.kind === "provider"
                          ? !i.providerType || i.providerType === "axiom"
                            ? t("Axiom Bearer authentication")
                            : t("{provider} API credential authentication", { provider: providerDefinitions[i.providerType].name })
                          : t("API key executor not mounted")
                        : t("No authentication requested")}{" "}
                  {t("· credentials are never part of exported configuration")}</p>
                {i.kind === "provider" && i.auth === "api-key" && (
                  <ProviderToken
                    api={api}
                    provider={i}
                    busy={engineControlsBusy}
                    refreshAfter={providerAuthRevision}
                  />
                )}
                {i.providerType === "openrouter" && (
                  <ProviderLogin
                    api={api}
                    provider={i}
                    busy={engineControlsBusy}
                    web={caps?.transport === "local-http"}
                    onAuthorized={providerAuthorized}
                  />
                )}
                {i.providerType === "gemini" && i.auth === "oauth" && (
                  <GoogleAccount
                    api={api}
                    provider={i}
                    busy={engineControlsBusy}
                    web={caps?.transport === "local-http"}
                    onAuthorized={providerAuthorized}
                  />
                )}
                {i.kind === "provider" ? (
                  <p>
                    {i.providerType === "openai"
                      ? t("Original OpenAI Core provider · account required")
                      : i.providerType === "xai"
                        ? t("xAI Responses provider · separate API key required")
                        : i.providerType === "openrouter"
                          ? t("OpenRouter Responses provider · API key or browser sign-in")
                          : i.providerType === "deepseek"
                            ? t("DeepSeek Responses provider · separate API key required")
                            : i.providerType === "mistral"
                              ? t("Mistral native Chat Completions provider · separate API key required")
                              : i.providerType === "compatible"
                                ? t("Custom Responses endpoint · explicit catalog/operator capabilities, not Chat-only compatibility")
                                : i.providerType === "gemini"
                                  ? t("Gemini native GenerateContent provider · {authentication}", { authentication: i.auth === "oauth" ? t("Google OAuth with automatic token refresh") : t("separate Google API key required") })
                                  : i.providerType === "anthropic"
                                    ? t("Anthropic native Messages provider · separate Claude API credential required")
                                    : t("Axiom Responses provider")}{" "}
                    {t("· choose the model in Settings")}</p>
                ) : (
                  <p>
                    {i.executor && i.executor !== "configuration-only"
                      ? i.executor
                      : t("Configuration only")}{" "}
                    {t("· {count} mounted tools", { count: number(mounted.length) })}
                  </p>
                )}
                {i.kind !== "provider" &&
                (!i.executor || i.executor === "configuration-only") ? (
                  <p>{t("{count} declared tools · no executor selected", { count: number(i.tools.length) })}</p>
                ) : null}
                {mounted.length > 0 && (
                  <details>
                    <summary>{t("Core tool catalog")}</summary>
                    <ul>
                      {mounted.map(
                        (tool) =>
                          tool && (
                            <li key={tool.name}>
                              <code>{tool.name}</code> — {tool.description}
                            </li>
                          ),
                      )}
                    </ul>
                  </details>
                )}
                <div className="actions">
                  <button
                    onClick={() => {
                      setIntegrationId(i.id);
                      setIntegration(i);
                    }}
                  >
                    {t("Edit")}</button>
                  <button
                    disabled={engineControlsBusy}
                    title={
                      engineControlsBusy
                        ? t("Wait for the current engine operation to finish")
                        : undefined
                    }
                    onClick={() =>
                      void run(async () => {
                        if (engineOperation.current) return;
                        acceptState(unwrap(await api.integrationDelete(i.id)));
                      })
                    }
                  >
                    {t("Remove configuration")}</button>
                </div>
              </article>
            );
          })}
      </div>
      {!state.integrations.some((i) => i.kind === kind) && (
        <div className="empty">
          <Plug />
          <h2>{t("No {kind} configurations yet", { kind })}</h2>
          <p>{t("Nothing is connected or advertised as available.")}</p>
        </div>
      )}
    </>
  );
  return (
    <div className={`app ${pref.compact ? "compact" : ""}`}>
      <aside id="synora-navigation" className="sidebar" hidden={sidebarCollapsed}>
        <div className="brand">
          <img src={brandSource} alt="Synora" />
          <span>HARNESS DESKTOP</span>
        </div>
        <button className="new-chat" onClick={() => void newConversation()}>
          <Plus size={16} />
          {t("New conversation")}</button>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => void selectView(id)}
            >
              <Icon size={17} />
              {t(label)}
              {id === "agents" &&
                (engine.agents.some((a) => a.status === "running") ||
                  state.delegations.some((t) =>
                    ["queued", "running"].includes(t.status),
                  )) && <i className="dot" />}
            </button>
          ))}
        </nav>
        <ConversationSidebar state={state} selected={conversation} activeId={engine.conversationId ?? engine.threadId} busy={busy}
          onOverlayChange={setConversationOverlay}
          writeClipboard={async text => { unwrap(await api.clipboardWriteText(text)); }}
          open={async id => { await selectConversation(id); await selectView("workspace"); }}
          preference={generalPreferences.save}
          remove={async id => {
            ensureCleanEditor();
            if (conversationWrite.current) throw Error(t("Wait for the current engine operation to finish"));
            let warning: string | undefined;
            const operation = (async () => {
              await flushDraft();
              const deleted = unwrap(await api.conversationDelete(id, true));
              acceptState(deleted.state);
              if (id === conversation) {
                setDraft(""); setDirectory("");
                const nextId = deleted.state.conversations.find(c => !c.archived)?.id;
                if (nextId) await selectConversation(nextId);
                else {
                  const c = unwrap(await api.newConversation(workspace || null));
                  await selectConversation(c.id);
                }
              }
              warning = deleted.cleanupWarning;
            })();
            conversationWrite.current = operation;
            try { await operation; return warning; } finally { if (conversationWrite.current === operation) conversationWrite.current = null; }
          }}
          update={async (id, patch) => {
            if (conversationWrite.current) throw Error(t("Wait for the current engine operation to finish"));
            if (patch.archived && id === conversation) { ensureCleanEditor(); await flushDraft(); }
            const operation = (async () => {
              const next = unwrap(await api.conversationUpdate(id, patch)); acceptState(next);
              if (patch.archived && id === conversation) {
                let nextId = next.conversations.find(c => !c.archived)?.id;
                if (!nextId) nextId = unwrap(await api.newConversation(workspace || null)).id;
                await selectConversation(nextId);
              }
            })();
            conversationWrite.current = operation;
            try { await operation; } finally { if (conversationWrite.current === operation) conversationWrite.current = null; }
          }}
          inspect={id => inspectBeside({ kind: "conversation", id })}
          fork={async id => {
            ensureCleanEditor(); await flushDraft();
            if (conversationWrite.current) throw Error(t("Wait for the current engine operation to finish"));
            const operation = (async () => {
              const c = unwrap(await api.conversationForkDraft(id, true));
              await refresh(); await selectConversation(c.id); await selectView("workspace");
            })();
            conversationWrite.current = operation;
            try { await operation; } finally { if (conversationWrite.current === operation) conversationWrite.current = null; }
          }} />
        <div className="side-bottom">
          <span className="dot" />
          <span>{t("Local services")}</span>
          <small>
            {live
              ? `${providerLabel} · ${state.engine.model}`
              : t("Engine simulation · no live model")}
          </small>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-heading">
            <div className="panel-toggles" aria-busy={panelPending}>
              <button type="button" data-testid="toggle-sidebar"
                aria-label={sidebarCollapsed ? t("Show navigation") : t("Hide navigation")}
                title={sidebarCollapsed ? t("Show navigation") : t("Hide navigation")}
                aria-controls="synora-navigation" aria-expanded={!sidebarCollapsed}
                aria-disabled={panelPending || pendingCompact !== null || localePending}
                onClick={() => togglePanel("sidebarCollapsed")}>
                {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </button>
              {view === "workspace" && <button type="button" data-testid="toggle-files"
                aria-label={filesCollapsed ? t("Show files panel") : t("Hide files panel")}
                title={filesCollapsed ? t("Show files panel") : t("Hide files panel")}
                aria-controls="synora-files" aria-expanded={!filesCollapsed}
                aria-disabled={panelPending || pendingCompact !== null || localePending}
                onClick={() => togglePanel("filesCollapsed")}>
                <FolderTree size={17} />
              </button>}
            </div>
            <div className="breadcrumb">
            <span className="muted">Synora /</span>{" "}
            {t(nav.find((n) => n.id === view)?.label ?? "Workspace")}
            {view === "workspace" && current?.defaults?.bot && <span
              className="badge bot-session-badge"
              aria-label={botText("Active bot: {name}", { name: current.defaults.bot.name })}
              title={botText("Active bot: {name}", { name: current.defaults.bot.name })}>
              <Bot size={13} aria-hidden="true" /><span>{current.defaults.bot.name}</span>
            </span>}
            </div>
          </div>
          <div className="actions">
            {view === "workspace" && <SplitToggle split={split} />}
            <ComputerControl api={api} conversationId={current?.id} busy={busy} open={controlPanelOpen} onOpenChange={setControlPanelOpen} onOpenBrowser={id => { setTab(id); void selectView("browser"); }} />
            <span className="badge">
              {live ? t("{provider} live", { provider: providerLabel }) : t("Simulator")}
            </span>
            <button
              aria-label={t("Toggle terminal")}
              onClick={() => setTerminal((t) => !t)}
            >
              <SquareTerminal size={17} />
            </button>
            <button
              aria-label={t("Open settings")}
              onClick={() => void selectView("settings")}
            >
              <Settings size={17} />
            </button>
          </div>
        </header>
        {(error || notice) && (
          <div
            role={error ? "alert" : "status"}
            className={`notice ${error ? "error" : ""}`}
          >
            <span>{error || notice}</span>
            <button
              aria-label={t("Dismiss message")}
              onClick={() => {
                setError("");
                setNotice("");
              }}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {enginePending && (
          <div className="notice" role="status" aria-live="polite">
            {t(enginePending)} {t("Sending and engine changes are unavailable until this operation finishes.")}</div>
        )}
        {restoreFailed === conversation && (
          <div className="notice" role="status">
            {t("The selected conversation could not be restored. Your history and draft are retained.")}<button
              disabled={engineControlsBusy}
              onClick={() => {
                if (engineOperation.current || busy) return;
                restoring.current = null;
                setRestoreFailed(null);
                setRestoreRequest((value) => value + 1);
              }}
            >
              {t("Retry restore")}</button>
          </div>
        )}
        <div className="content">
          {view === "workspace" && (
            <div className="workspace">
              <section id="synora-files" className="files" hidden={filesCollapsed}>
                <div className="toolbar">
                  <strong>{t("Files")}</strong>
                  <button
                    aria-label={t("Add workspace")}
                    onClick={() =>
                      void run(async () => {
                        ensureCleanEditor();
                        if (caps?.nativeDialogs) await addWorkspace();
                        else setWorkspacePrompt("");
                      })
                    }
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
                <select
                  aria-label={t("Active workspace")}
                  value={workspace}
                  onChange={(e) =>
                    void run(async () => {
                      ensureCleanEditor();
                      await selectWorkspace(e.target.value);
                    })
                  }
                >
                  <option value="">{t("No workspace")}</option>
                  {state.workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
                <div className="toolbar path">
                  <button
                    disabled={!directory}
                    aria-label={t("Parent folder")}
                    onClick={() =>
                      void run(async () => {
                        ensureCleanEditor();
                        setDirectory(
                          directory.split(/[\\/]/).slice(0, -1).join("/"),
                        );
                      })
                    }
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{directory || t("Workspace root")}</span>
                  <button
                    aria-label={t("Refresh files")}
                    onClick={() => void run(reloadFiles)}
                  >
                    <RefreshCw size={13} />
                  </button>
                </div>
                <div className="file-list">
                  {files.map((f) => (
                    <button
                      key={f.path}
                      onClick={() =>
                        void run(async () => {
                          if (document && edited !== document.content) {
                            setNotice(
                              t("Save or reload your edited file before opening another."),
                            );
                            return;
                          }
                          if (f.directory) setDirectory(f.path);
                          else {
                            const d = unwrap(
                              await api.readFile(workspace, f.path),
                            );
                            setDocument(d);
                            setEdited(d.content);
                          }
                        })
                      }
                    >
                      {f.directory ? (
                        <FolderOpen size={14} />
                      ) : (
                        <File size={14} />
                      )}
                      <span>{f.name}</span>
                    </button>
                  ))}
                </div>
                {!workspace && (
                  <p className="muted hint">
                    {t("Choose a folder to browse and edit real local files.")}</p>
                )}
              </section>
              <ConversationSplit state={state} engine={engine} api={api} split={split}>
              <section className="conversation">
                {!document && <RelatedSideTabs state={state} engine={engine} conversationId={conversation} open={split.open} />}
                {document ? (
                  <>
                    <div className="toolbar">
                      <strong>{document.path}</strong>
                      <span className="muted">
                        {edited !== document.content
                          ? t("Unsaved changes")
                          : t("Saved")}
                      </span>
                      <button
                        onClick={() =>
                          void run(async () => {
                            const d = unwrap(
                              await api.saveFile(workspace, {
                                ...document,
                                content: edited,
                              }),
                            );
                            setDocument(d);
                            setNotice(t("File saved."));
                          })
                        }
                      >
                        <Save size={14} />
                        {t("Save")}</button>
                      <button
                        onClick={() =>
                          void run(async () => {
                            const d = unwrap(
                              await api.readFile(workspace, document.path),
                            );
                            setDocument(d);
                            setEdited(d.content);
                          })
                        }
                      >
                        {t("Reload")}</button>
                      <button
                        aria-label={t("Close editor")}
                        onClick={() => {
                          if (edited !== document.content)
                            setNotice(
                              t("Save or reload your changes before closing the editor."),
                            );
                          else setDocument(null);
                        }}
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <textarea
                      className="editor"
                      aria-label={t("File contents")}
                      value={edited}
                      spellCheck={false}
                      onChange={(e) => setEdited(e.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <div className="chat-scroll" ref={scroll}>
                      {timeline.length ? (
                        timeline.map((entry) =>
                          entry.type === "tool" ? (
                            <ToolActivity
                              key={entry.id}
                              item={entry.item}
                              simulated={entry.simulated}
                              compaction={[
                                ...(engine.compactions ?? []),
                                ...(current?.compactions ?? []),
                              ].find((r) => r.id === entry.id)}
                            />
                          ) : (
                            <article
                              className={`message ${entry.message.role}`}
                              key={entry.id}
                            >
                              <div className="message-label">
                                {entry.message.role === "user"
                                  ? t("You")
                                  : "Synora"}{" "}
                                <span className="muted">
                                  {entry.message.simulated ? t("simulation") : ""}
                                  {entry.message.incomplete && !busy
                                    ? t(" · Incomplete response")
                                    : ""}
                                </span>
                              </div>
                              <MessageText assistant={entry.message.role === "assistant"}
                                text={entry.message.text || (entry.message.imageIds?.length ? "" : "…")} />
                              <div className="image-attachments">
                                {entry.message.imageIds?.map((id) => {
                                  const image = current?.attachments?.find(
                                    (i) => i.id === id,
                                  );
                                  return image ? (
                                    <AttachedImage
                                      key={id}
                                      api={api}
                                      conversationId={conversation}
                                      image={image}
                                    />
                                  ) : (
                                    <span key={id} role="alert">
                                      {t("Image attachment unavailable")}</span>
                                  );
                                })}
                              </div>
                            </article>
                          ),
                        )
                      ) : (
                        <div className="welcome welcome-fit">
                          <div className="welcome-heading">
                            <img src={brandSource} alt="Synora" />
                            <div>
                              <h1>{t("A space for focused work.")}</h1>
                              <p>{t("Your files, agents and tools. One workspace.")}</p>
                            </div>
                          </div>
                          <ConversationStarters adaptive draft={draft} choose={text => {
                            changeDraft(text);
                            requestAnimationFrame(() => composerInput.current?.focus());
                          }} />
                          <p className="simulation-note">
                            {live
                              ? t("Live {provider} through Codex App Server.", { provider: providerLabel })
                              : t("Foundation mode: chat and agents are simulated.")}
                          </p>
                        </div>
                      )}
                      {engine.status === "failed" && activeConversation && (
                        <div className="notice error">
                          {live
                            ? (engine.error?.message ?? t("The live turn failed."))
                            : t("Simulated upstream failure. No model request was sent.")}
                        </div>
                      )}
                      {engine.approval && activeConversation && (
                        <div className="approval">
                          <strong>
                            {live
                              ? t("Approval request")
                              : t("Simulated approval request")}
                          </strong>
                          <p>{"serverName" in engine.approval.params
                            ? engine.approval.params.message : engine.approval.params.reason}</p>
                          <code>
                            {"serverName" in engine.approval.params
                              ? `${engine.approval.params.serverName}\n${JSON.stringify(
                                  engine.approval.params._meta && typeof engine.approval.params._meta === "object" && !Array.isArray(engine.approval.params._meta)
                                    ? engine.approval.params._meta.tool_params : {}, null, 2)}`
                              : "command" in engine.approval.params
                              ? engine.approval.params.command
                              : "permissions" in engine.approval.params
                                ? JSON.stringify(
                                    engine.approval.params.permissions,
                                    null,
                                    2,
                                  )
                                : t("File changes · {id}", { id: engine.approval.params.itemId })}
                          </code>
                          <details>
                            <summary>{t("Complete permission request")}</summary>
                            <pre>
                              {JSON.stringify(engine.approval.params, null, 2)}
                            </pre>
                          </details>
                          <div className="actions">
                            <button
                              disabled={
                                !commandDecisionAllowed(
                                  engine.approval.params,
                                  "decline",
                                )
                              }
                              onClick={() =>
                                void run(async () =>
                                  snapshot(
                                    unwrap(
                                      await api.engineApprove(
                                        engine.approval!.id,
                                        false,
                                      ),
                                    ),
                                  ),
                                )
                              }
                            >
                              {t("Decline")}</button>
                            <button
                              disabled={
                                !commandDecisionAllowed(
                                  engine.approval.params,
                                  "accept",
                                )
                              }
                              onClick={() =>
                                void run(async () =>
                                  snapshot(
                                    unwrap(
                                      await api.engineApprove(
                                        engine.approval!.id,
                                        true,
                                      ),
                                    ),
                                  ),
                                )
                              }
                            >
                              {live
                                ? "permissions" in engine.approval.params
                                  ? t("Approve for this turn")
                                  : t("Approve once")
                                : t("Approve simulation")}
                            </button>
                          </div>
                        </div>
                      )}
                      {activeConversation &&
                        engine.questions?.map((request) => (
                          <UserQuestion
                            key={request.id}
                            request={request}
                            api={api}
                            updated={snapshot}
                          />
                        ))}
                      {live && (
                        <AppServerConnection
                          engine={engine}
                          busy={!!enginePending || busy}
                          reconnect={() =>
                            void run(() =>
                              runEngineOperation(async () => {
                                const r = unwrap(
                                  await api.engineReconnect(engine.sequence),
                                );
                                snapshot(r.snapshot);
                                await refresh();
                              }, "Reconnecting the engine…"),
                            )
                          }
                        />
                      )}
                      {!live && engine.connection === "disconnected" && (
                        <div className="notice">
                          <span>
                            {t("Simulated transport disconnected. Work can complete independently.")}</span>
                          <button
                            disabled={!!enginePending}
                            onClick={() =>
                              void run(() =>
                                runEngineOperation(async () => {
                                  const r = unwrap(
                                    await api.engineReconnect(engine.sequence),
                                  );
                                  snapshot(r.snapshot);
                                  await refresh();
                                }, "Reconnecting the engine…"),
                              )
                            }
                          >
                            {t("Reconnect")}</button>
                        </div>
                      )}
                    </div>
                    <section className="tutor-entry" aria-label={t("Tutor mode")}>
                      <div>
                        <strong>
                          {current?.orchestration
                            ? t("Tutor mode enabled")
                            : t("Tutor mode")}
                        </strong>
                        <span>
                          {current?.orchestration
                            ? t("{model} supervises {workers}.", { model: state.engine.model ?? t("Unavailable"), workers: current.orchestration.workers.map((w) => w.name).join(", ") })
                            : t("Choose a supervisor to plan and review work delegated to your AI LLM Models.")}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void selectView("agents")}
                      >
                        {current?.orchestration
                          ? t("View team and tasks")
                          : t("Set up tutor")}
                      </button>
                    </section>
                    <form
                      className="composer"
                      onPaste={(e) => {
                        const files = transferredFiles(e.clipboardData);
                        if (!files.length) return; // Native text paste, caret and undo are unchanged.
                        e.preventDefault();
                        const text = e.clipboardData.getData("text/plain");
                        const input = composerInput.current;
                        if (text && input && e.target === input) {
                          const start = input.selectionStart, end = input.selectionEnd;
                          changeDraft(input.value.slice(0, start) + text + input.value.slice(end));
                          requestAnimationFrame(() => input.setSelectionRange(start + text.length, start + text.length));
                        }
                        void uploadImages(files);
                      }}
                      onDragOver={(e) => {
                        if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
                      }}
                      onDrop={(e) => {
                        const files = transferredFiles(e.dataTransfer);
                        if (!files.length) return;
                        e.preventDefault();
                        void uploadImages(files);
                        composerInput.current?.focus({ preventScroll: true });
                      }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (busy) submitBusyMessage();
                        else if (!busySubmissionPending) void send();
                      }}
                    >
                      <div
                        className="image-attachments"
                        aria-label={t("Draft images")}
                      >
                        {current?.draftImageIds?.map((id) => {
                          const image = current.attachments?.find(
                            (i) => i.id === id,
                          );
                          return image ? (
                            <AttachedImage
                              key={id}
                              api={api}
                              conversationId={conversation}
                              image={image}
                              disabled={busy || attachmentBusy}
                              remove={() =>
                                void run(async () =>
                                  acceptState(
                                    unwrap(
                                      await api.imageRemove(conversation, id),
                                    ),
                                  ),
                                )
                              }
                            />
                          ) : (
                            <span key={id} role="alert">
                              {t("Draft image unavailable")}</span>
                          );
                        })}
                      </div>
                      <textarea
                        ref={composerInput}
                        aria-label={t("Message")}
                        title={t("Up recalls sent messages from an empty field or the start of a single-line draft; Down returns to your draft. Click or type to edit.")}
                        placeholder={t("Describe what you want to work on…")}
                        value={draft}
                        onChange={(e) => changeDraft(e.target.value)}
                        onPointerDown={() => composerHistory.current.reset()}
                        onKeyDown={(e) => {
                          const recalled = composerHistory.current.recall(conversation, current?.messages ?? [], draft,
                            e.currentTarget.selectionStart, e.currentTarget.selectionEnd,
                            { key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
                              metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing });
                          if (recalled !== null) {
                            e.preventDefault();
                            changeDraft(recalled, true);
                            requestAnimationFrame(() => {
                              const input = composerInput.current;
                              if (input && latestComposer.current.conversation === conversation && input.value === recalled)
                                input.setSelectionRange(recalled.length, recalled.length);
                            });
                            return;
                          }
                          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            if (busy) { submitBusyMessage(e.metaKey || e.ctrlKey); return; }
                            if (busySubmissionWrite.current) return;
                            if (
                              (draft.trim() ||
                                current?.draftImageIds?.length) &&
                              !attachmentBusy &&
                              !engineControlsBusy &&
                              (live || engine.connection !== "disconnected")
                            )
                              void send();
                          }
                        }}
                      />
                      <div className="composer-controls">
                        <ComposerAdd busy={engineControlsBusy || attachmentBusy}
                          plugins={() => void selectView("plugins")}
                          models={() => void selectView("models")}>
                        {live && (
                          <button
                            type="button"
                            disabled={
                              engineControlsBusy ||
                              attachmentBusy ||
                              !current?.binding
                            }
                            title={t("Ask Core to summarize working context; visible history and unsent drafts are retained")}
                            onClick={() =>
                              void run(async () => {
                                if (engineOperation.current) return;
                                await flushDraft();
                                if (engineOperation.current) return;
                                unwrap(await api.engineCompact(conversation));
                              })
                            }
                          >
                            {t("Compact context")}</button>
                        )}
                        {live && (
                          <ImageInput
                            busy={engineControlsBusy || attachmentBusy}
                            upload={uploadImages}
                          />
                        )}
                        </ComposerAdd>
                        {live && <PermissionPicker
                          busy={engineControlsBusy || attachmentBusy}
                          mode={current ? (current.defaults?.permission ?? current.binding?.permission ?? "ask") : (pref.permission ?? "ask")}
                          change={async (permission) => {
                            await runEngineOperation(async () => {
                              await flushDraft();
                              // Only the selected chat changes. Core acknowledges the
                              // policy on resume before its next turn; no new chat.
                              acceptState(unwrap(await api.conversationPermission(conversation || null, permission)));
                            });
                          }} />}
                        {!live && (
                          <select
                            aria-label={t("Simulation scenario")}
                            value={scenario}
                            onChange={(e) =>
                              setScenario(e.target.value as Scenario)
                            }
                          >
                            {scenarios.map((s) => (
                              <option key={s} value={s}>
                                {t("{scenario} simulation", { scenario: s })}
                              </option>
                            ))}
                          </select>
                        )}
                        {live && (
                          <select
                            aria-label={t("Collaboration mode")}
                            disabled={engineControlsBusy}
                            value={pref.mode}
                            onChange={(e) =>
                              void run(async () => {
                                if (engineOperation.current) return;
                                acceptState(
                                  unwrap(
                                    await api.preferences({
                                      mode: e.target.value as
                                        | "default"
                                        | "plan",
                                    }),
                                  ),
                                );
                              })
                            }
                          >
                            <option value="default">{t("Execute")}</option>
                            <option value="plan">{t("Plan")}</option>
                          </select>
                        )}
                        <WorkspaceModelPicker
                          api={api} state={state} busy={engineControlsBusy}
                          runOperation={runEngineOperation}
                          accounts={() => void selectView("models")}
                          apply={applyWorkspaceModel} />
                        {openAi ? (
                          <>
                            <select
                              aria-label={t("Reasoning effort")}
                              title={
                                state.engine.reasoningEffort
                                  ? selectedCoreModel?.reasoning_efforts.includes(
                                      state.engine.reasoningEffort,
                                    )
                                    ? state.engine.reasoningEffort
                                    : t("{effort} is unavailable; refresh the model catalog", { effort: state.engine.reasoningEffort })
                                  : t("Provider default: no reasoning effort override")
                              }
                              disabled={
                                engineControlsBusy ||
                                !selectedCoreModel?.reasoning_efforts.length
                              }
                              value={state.engine.reasoningEffort ?? ""}
                              onChange={(e) => {
                                const effort = e.target.value;
                                const {
                                  reasoningEffort: _previousEffort,
                                  ...configuration
                                } = state.engine;
                                void run(() =>
                                  runEngineOperation(async () => {
                                    snapshot(
                                      unwrap(
                                        await api.engineConfigure({
                                          ...configuration,
                                          ...(effort
                                            ? { reasoningEffort: effort }
                                            : {}),
                                        }),
                                      ),
                                    );
                                    await refresh();
                                  }),
                                );
                              }}
                            >
                              <option value="">{t("Provider default")}</option>
                              {state.engine.reasoningEffort &&
                                !selectedCoreModel?.reasoning_efforts.includes(
                                  state.engine.reasoningEffort,
                                ) && (
                                  <option
                                    value={state.engine.reasoningEffort}
                                    disabled
                                  >
                                    {t("Unavailable: {effort}", { effort: state.engine.reasoningEffort })}
                                  </option>
                                )}
                              {selectedCoreModel?.reasoning_efforts.map((e) => (
                                <option key={e} value={e}>
                                  {e}
                                </option>
                              ))}
                            </select>
                          </>
                        ) : (
                          <>
                            <select
                              aria-label={t("Reasoning profile")}
                              disabled={engineControlsBusy}
                              value={pref.profile}
                              onChange={(e) =>
                                void run(async () => {
                                  if (engineOperation.current) return;
                                  acceptState(
                                    unwrap(
                                      await api.preferences({
                                        profile: e.target
                                          .value as (typeof profiles)[number],
                                      }),
                                    ),
                                  );
                                })
                              }
                            >
                              {profiles.map((p) => (
                                <option
                                  key={p}
                                  value={p}
                                  disabled={
                                    live &&
                                    !!engine.modelCatalog &&
                                    !engine.modelCatalog
                                      .find((m) => m.id === state.engine.model)
                                      ?.reasoning_efforts.includes(p)
                                  }
                                >
                                  {p === "ultra-fast" ? t("Ultra-fast / Off") : p}
                                </option>
                              ))}
                            </select>
                            <select
                              aria-label={t("Context")}
                              disabled={engineControlsBusy}
                              value={pref.context}
                              onChange={(e) =>
                                void run(async () => {
                                  if (engineOperation.current) return;
                                  acceptState(
                                    unwrap(
                                      await api.preferences({
                                        context: Number(e.target.value) as
                                          | 262144
                                          | 1048576,
                                      }),
                                    ),
                                  );
                                })
                              }
                            >
                              {[262144, 1048576].map((context) => (
                                <option
                                  key={context}
                                  value={context}
                                  disabled={
                                    live &&
                                    !!engine.modelCatalog &&
                                    !engine.modelCatalog
                                      .find((m) => m.id === state.engine.model)
                                      ?.context_window_options.includes(context)
                                  }
                                >
                                  {context === 262144 ? "262K" : "1M"}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                        {live && <ContextUsage engine={conversationEngine} selected={openAi ? null : pref.context} />}
                        {busy ? (
                          <button
                            type="button"
                            aria-label={t("Cancel turn")}
                            className="send"
                            onClick={() =>
                              void run(async () =>
                                snapshot(unwrap(await api.engineCancel())),
                              )
                            }
                          >
                            <Square size={16} />
                          </button>
                        ) : (
                          <button
                            type="submit"
                            className="send"
                            aria-label={t("Send message")}
                            title={
                              enginePending
                                ? t("Wait for the current engine operation to finish")
                                : undefined
                            }
                            disabled={
                              !!enginePending ||
                              busySubmissionPending ||
                              attachmentBusy ||
                              (!draft.trim() &&
                                !current?.draftImageIds?.length) ||
                              (!live && engine.connection === "disconnected")
                            }
                          >
                            <ArrowUp size={19} />
                          </button>
                        )}
                      </div>
                    </form>
                    <BusyMessageStatus queue={current?.queuedMessages}
                      behavior={pref.busyEnterBehavior ?? "queue"}
                      available={busySubmissionAvailable} pending={busySubmissionPending}
                      canSubmit={busySubmissionAvailable && !!draft.trim() && !busySubmissionPending}
                      submit={submitBusyMessage}
                      submitted={busySubmissionReceipt?.conversationId === conversation &&
                        busySubmissionReceipt.threadId === engine.threadId && busySubmissionReceipt.turnId === engine.turnId
                        ? busySubmissionReceipt.behavior : null}
                      removing={!!queueRemoval}
                      removingId={queueRemoval?.conversationId === conversation ? queueRemoval.messageId : null}
                      remove={removeQueuedMessage}
                      addToDraft={(text) => changeDraft(draft ? `${draft}\n\n${text}` : text)}
                      focusDraft={() => {
                        if (latestComposer.current.conversation === conversation) composerInput.current?.focus();
                      }} />
                    <p className="composer-caption">
                      {engine.cleanupPending
                        ? t("Closing the owned Core connection; the conversation is saved for resume.")
                        : live
                          ? openAi
                            ? t("Selected provider model and reasoning effort. Context is managed by Core; open Model settings to read or change the advertised catalog.")
                            : t("Profile and context are sent to Axiom with each request. Context is the selected capacity, not the number of tokens used.")
                          : t("Profile and context are saved preferences, not live inference settings.")}
                    </p>
                  </>
                )}
              </section>
              </ConversationSplit>
            </div>
          )}
          {view === "agents" && (
            <section className="page">
              <div className="page-title">
                <div>
                  <p className="eyebrow">{t("ORCHESTRATION")}</p>
                  <h1>{t("Tutor, workers and agents")}</h1>
                  <p>
                    {t("Names, parent conversations, tasks and results. Live and simulated records are labelled separately.")}</p>
                </div>
                <button
                  onClick={() =>
                    void run(async () => {
                      if (state.engine.mode === "simulated")
                        setScenario("agents");
                      await selectView("workspace");
                    })
                  }
                >
                  {state.engine.mode === "simulated"
                    ? t("Try agent scenario")
                    : t("Open conversation to delegate")}
                </button>
              </div>
              <section className="tutor-setup" aria-label={t("Tutor setup")}>
                <h2>{t("1. Choose the supervisor")}</h2>
                <p>
                  {t("The supervisor receives your request, plans the work, calls the configured workers and reviews their results. Select GPT, Claude or another connected model; your AI LLM Models can be workers independently.")}</p>
                <WorkspaceModelPicker
                  api={api}
                  state={state}
                  busy={engineControlsBusy}
                  runOperation={runEngineOperation}
                  apply={applyWorkspaceModel}
                  accounts={() => void selectView("models")}
                />
                {(current?.binding ||
                  current?.messages.length ||
                  current?.activity.length ||
                  !current) && (
                  <div className="notice">
                    {t("Keep the existing history. Start a new conversation before enabling a worker catalog.")}<button
                      type="button"
                      disabled={engineControlsBusy}
                      onClick={() => void newConversation()}
                    >
                      {t("New supervised conversation")}</button>
                  </div>
                )}
                <label>
                  {t("Supervisor workspace")}<select
                    aria-label={t("Supervisor workspace")}
                    value={workspace}
                    disabled={
                      engineControlsBusy ||
                      !!current?.binding ||
                      !!current?.messages.length
                    }
                    onChange={(e) =>
                      void run(() => selectWorkspace(e.target.value))
                    }
                  >
                    <option value="">{t("Select a workspace")}</option>
                    {state.workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} — {w.path}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={
                    engineControlsBusy ||
                    !!current?.binding ||
                    !!current?.messages.length
                  }
                  onClick={() =>
                    void run(async () => {
                      if (caps?.nativeDialogs) await addWorkspace();
                      else setWorkspacePrompt("");
                    })
                  }
                >
                  {t("Choose supervisor folder")}</button>
                <p>
                  {t("Choose separate folders for the supervisor and workers to prevent conflicting writes. They exchange task instructions and results through Synora, not shared credentials.")}</p>
                <h2>{t("2. Configure workers below")}</h2>
                <p>
                  {t("Add your AI LLM Models as workers, select their real models/profiles and project folder, confirm data sharing, then save. Other configured providers can also be workers.")}</p>
              </section>
              <OrchestrationPanel
                api={api}
                state={state}
                conversationId={conversation || null}
                busy={engineControlsBusy}
                onState={acceptState}
                onError={setError}
                onInspect={task => inspectBeside({ kind: "task", id: task.id, parentId: task.parentConversationId })}
              />
              <section
                className="tutor-setup"
                aria-label={t("Start supervised work")}
              >
                <h2>{t("3. Give the supervisor a task")}</h2>
                <p>
                  {current?.orchestration
                    ? t("Your worker catalog is saved. Return to the conversation and describe the task. Delegations, progress, results and the supervisor's explicit review appear here.")
                    : t("Save a worker configuration above first. Saving does not start an inference request.")}
                </p>
                <button
                  type="button"
                  disabled={!current?.orchestration || engineControlsBusy}
                  onClick={() => void selectView("workspace")}
                >
                  {t("Open supervised conversation")}</button>
              </section>
              <div className="cards">
                {state.agentHistory.map((a) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    inspect={() => inspectBeside({ kind: "agent", id: a.id })}
                    openParent={() =>
                      void run(async () => {
                        const parent = state.conversations.find(
                          (c) =>
                            c.id === a.parentId ||
                            c.binding?.threadId === a.parentId,
                        );
                        if (!parent)
                          throw new Error(
                            t("Parent conversation is not available in this workspace"),
                          );
                        await selectConversation(parent.id);
                        await selectView("workspace");
                      })
                    }
                  />
                ))}
              </div>
              {!state.agentHistory.length && !state.delegations.length && (
                <div className="empty">
                  <Network />
                  <h2>{t("No agent activity yet")}</h2>
                  <p>
                    {state.engine.mode === "simulated"
                      ? t("Run the agents simulation to verify lifecycle and history.")
                      : t("Ask the model to delegate a task in a live conversation. Actual child names, work and results appear here.")}
                  </p>
                </div>
              )}
            </section>
          )}
          <BotLibrary
            api={api}
            state={state}
            active={view === "bots"}
            useLocked={engineControlsBusy}
            acceptState={acceptState}
            onUse={useBot}
          />
          {view === "browser" && (
            <section className="browser-page">
              <div className="toolbar">
                <Globe size={18} />
                <strong>{t("Isolated browser")}</strong>
                <span className="muted">
                  {t("No filesystem, Node or Synora service access from pages")}</span>
              </div>
              <div className="tabs">
                {tabs.map((browserTab) => (
                  <button
                    className={tab === browserTab.id ? "selected" : ""}
                    key={browserTab.id}
                    onClick={() => {
                      setTab(browserTab.id);
                      setURL(browserTab.url);
                    }}
                  >
                    {browserTab.loading ? t("Loading…") : browserTab.title.slice(0, 30)}
                  </button>
                ))}
              </div>
              <form
                className="browser-toolbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    if (tab) unwrap(await api.browserNavigate(tab, url));
                    else {
                      const result = unwrap(await api.browserOpen(url));
                      setTabs(result);
                      setTab(result.at(-1)!.id);
                    }
                  });
                }}
              >
                <button
                  type="button"
                  aria-label={t("Browser back")}
                  disabled={!tabs.find((t) => t.id === tab)?.canGoBack}
                  onClick={() =>
                    void run(async () =>
                      setTabs(unwrap(await api.browserAction(tab, "back"))),
                    )
                  }
                >
                  <ChevronLeft />
                </button>
                <button
                  type="button"
                  aria-label={t("Browser forward")}
                  disabled={!tabs.find((t) => t.id === tab)?.canGoForward}
                  onClick={() =>
                    void run(async () =>
                      setTabs(unwrap(await api.browserAction(tab, "forward"))),
                    )
                  }
                >
                  <ChevronRight />
                </button>
                <input
                  aria-label={t("Browser address")}
                  value={url}
                  onChange={(e) => setURL(e.target.value)}
                  placeholder="https://example.org"
                />
                <button type="submit">{t("Go")}</button>
                <button
                  type="button"
                  onClick={() => {
                    setTab("");
                    setURL("");
                  }}
                >
                  {t("New tab")}</button>
                {tab && (
                  <button
                    type="button"
                    aria-label={t("Close browser tab")}
                    onClick={() =>
                      void run(async () => {
                        const result = unwrap(
                          await api.browserAction(tab, "close"),
                        );
                        setTabs(result);
                        setTab(result[0]?.id ?? "");
                        setURL(result[0]?.url ?? "");
                      })
                    }
                  >
                    <X />
                  </button>
                )}
              </form>
              {tabs.find((t) => t.id === tab)?.error && (
                <div className="notice error">
                  {tabs.find((t) => t.id === tab)!.error}
                </div>
              )}
              <div className="browser-surface" ref={browserRect}>
                {tab && (caps?.browserPresentation === "remote-frame" || controlPanelOpen) && (
                  <RemoteBrowser key={tab} api={api} id={tab} report={report} />
                )}
                {!tab && (
                  <div className="empty">
                    <Globe />
                    <h2>{t("Your browser, in the workspace.")}</h2>
                    <p>
                      {t("Enter an HTTP(S) address. Navigation uses a separate sandboxed page.")}</p>
                    <p className="muted">
                      {t("Permissions, downloads and popups are not enabled in this foundation.")}</p>
                  </div>
                )}
              </div>
            </section>
          )}
          {view === "models" && (
            <section className="page">
              {configView("provider", t("Models & accounts."))}
            </section>
          )}
          {view === "connectors" && (
            <section className="page">
              {configView("connector", t("Connect your work."))}
              <CoreCatalog
                api={api}
                state={state}
                busy={engineControlsBusy}
                kind="apps"
              />
            </section>
          )}
          {view === "plugins" && (
            <section className="page">
              <PluginDirectory
                api={api}
                state={state}
                busy={engineControlsBusy}
                onState={acceptState}
              />
              {configView("mcp", t("Custom MCP connections."))}
            </section>
          )}
          {view === "telemetry" && (
            <section className="page">
              <div className="page-title">
                <div>
                  <p className="eyebrow">{t("OBSERVABILITY")}</p>
                  <h1>{t("Know what is running.")}</h1>
                  <p>
                    {t("Live local measurements are separate from simulated engine activity.")}</p>
                </div>
                <span className="badge">{t("Refresh every 2s")}</span>
              </div>
              <div className="metric-grid">
                {[
                  [
                    t("Local terminals"),
                    number(metrics?.terminalCount ?? 0),
                    t("Real OS processes owned by Synora"),
                  ],
                  [
                    t("Browser tabs"),
                    number(metrics?.browserCount ?? 0),
                    t("Isolated local Chromium views"),
                  ],
                  [
                    t("Engine"),
                    engine.status,
                    live
                      ? t("Actual App Server turn")
                      : t("Simulated · no provider request"),
                  ],
                ].map(([title, value, help]) => (
                  <article className="card metric" key={title}>
                    <span>{title}</span>
                    <strong>{value}</strong>
                    <small>{help}</small>
                  </article>
                ))}
              </div>
              <ResourceTelemetry key={`${state.engine.mode}:${state.engine.providerId}:${engine.threadId}`}
                api={api} engine={engine} metrics={metrics}
                axiom={live && !openAi} />
              {!openAi && <AxiomTelemetry requests={engine.backendRequests} />}
              <article className="card">
                <h2>{t("Engine identity")}</h2>
                <dl>
                  <dt>{t("Protocol")}</dt>
                  <dd>
                    Codex App Server {PROTOCOL_VERSION} ·{" "}
                    {live ? t("live adapter") : t("simulator adapter")}
                  </dd>
                  {engine.selection && (
                    <>
                      <dt>{t("Prepared provider selection")}</dt>
                      <dd>
                        {engine.selection.model} ·{" "}
                        {engine.selection.profile || t("Core default")} ·{" "}
                        {engine.selection.context === null
                          ? t("Core-managed context")
                          : t("{count} tokens", { count: number(engine.selection.context) })}
                      </dd>
                      <dt>{t("Context routing")}</dt>
                      <dd>
                        {engine.selection.contextRequestField === "core-managed"
                          ? t("Original Core defaults; no Axiom context override")
                          : t("context_window · isolated local adapter · not a long-context benchmark")}
                      </dd>
                    </>
                  )}
                  <dt>{t("Conversation")}</dt>
                  <dd className="mono">{engine.threadId ?? t("None")}</dd>
                  <dt>{t("Turn")}</dt>
                  <dd className="mono">{engine.turnId ?? t("None")}</dd>
                  <dt>{t("Session")}</dt>
                  <dd className="mono">{engine.sessionId ?? t("None")}</dd>
                  <dt>{t("First text delta")}</dt>
                  <dd>
                    {engine.firstDeltaAt && engine.startedAt
                      ? t("{milliseconds} ms after turn start", { milliseconds: number(engine.firstDeltaAt - engine.startedAt) })
                      : t("Not observed")}
                  </dd>
                  <dt>{t("Last sequence")}</dt>
                  <dd>{number(engine.sequence)}</dd>
                  <dt>{t("Transport")}</dt>
                  <dd>{engine.connection}</dd>
                  <dt>{t("Host platform")}</dt>
                  <dd>
                    {caps?.platform} / {caps?.transport}
                  </dd>
                </dl>
              </article>
            </section>
          )}
          {view === "settings" && (
            <section className="page">
              <div className="page-title">
                <div>
                  <p className="eyebrow">{t("LOCAL PREFERENCES")}</p>
                  <h1>{t("Make room for your work.")}</h1>
                  <p>
                    {t("Saved by your local Synora service. No changes to Axiom or external accounts.")}</p>
                </div>
              </div>
              <GeneralSettings
                state={state}
                capabilities={caps}
                busy={generalPreferences.pending || localePending || pendingCompact !== null || panelPending}
                pending={generalPreferences.pending}
                error={generalPreferences.error}
                save={generalPreferences.save}
              >
                <label className="general-setting-row">
                  <strong>{t("Language")}</strong>
                  <select
                    aria-label={t("Language")}
                    data-testid="app-language"
                    value={locale}
                    disabled={localePending || pendingCompact !== null || panelPending || generalPreferences.pending}
                    aria-busy={localePending}
                    onChange={(e) => {
                      if (preferenceWrite.current) return;
                      const nextLocale = e.currentTarget.value as typeof locale;
                      setLocalePending(true);
                      preferenceWrite.current = run(async () => {
                        try {
                          const updated = unwrap(await api.preferences({ locale: nextLocale }));
                          acceptState(updated);
                          setLocale(updated.preferences.locale ?? "en");
                        } finally {
                          setLocalePending(false);
                          preferenceWrite.current = null;
                        }
                      });
                    }}
                  >
                    {Object.entries(localeNames).map(([value, name]) => (
                      <option key={value} value={value}>{name}</option>
                    ))}
                  </select>
                </label>
              </GeneralSettings>
              <CoreUpdateSettings api={api} busy={engineControlsBusy} />
              <LocalMemorySettings api={api} state={state} updated={acceptState} />
              <EngineSettings
                api={api}
                servicePlatform={caps?.platform}
                state={state}
                busy={busy}
                operationPending={!!enginePending}
                runOperation={runEngineOperation}
                applied={async (s) => {
                  snapshot(s);
                  await refresh();
                  setCaps(unwrap(await api.capabilities()));
                }}
              />
              <article className="card settings-card">
                <label>
                  <span>
                    <strong>{t("Compact interface")}</strong>
                    <small>{t("Reduce spacing across the workspace")}</small>
                  </span>
                  <input
                    aria-label={t("Compact interface")}
                    type="checkbox"
                    checked={pref.compact}
                    disabled={pendingCompact !== null || localePending || panelPending || generalPreferences.pending}
                    aria-busy={pendingCompact !== null}
                    onChange={(e) => {
                      if (preferenceWrite.current) return;
                      const compact = e.currentTarget.checked;
                      setPendingCompact(compact);
                      preferenceWrite.current = run(async () => {
                        try {
                          acceptState(
                            unwrap(await api.preferences({ compact })),
                          );
                        } finally {
                          setPendingCompact(null);
                          preferenceWrite.current = null;
                        }
                      });
                    }}
                  />
                </label>
                <div>
                  <strong>{t("Engine connection")}</strong>
                  <span>
                    {live
                      ? `${providerLabel} · ${state.engine.model}`
                      : t("Explicit simulator")}
                  </span>
                </div>
                <div>
                  <strong>{t("Distribution")}</strong>
                  <span>
                    {t("Local unsigned builds; no automatic update channel")}</span>
                </div>
                <div>
                  <strong>{t("Version")}</strong>
                  <span>{applicationVersion}</span>
                </div>
              </article>
            </section>
          )}
        </div>
        {terminal && (
          <Suspense
            fallback={<div className="notice">{t("Opening terminal panel…")}</div>}
          >
            <TerminalPanel
              api={api}
              workspaces={state.workspaces}
              report={report}
            />
          </Suspense>
        )}
        <StatusBar api={api} engine={engine} conversationEngine={conversationEngine}
          live={!!live} axiom={!!live && !openAi} providerLabel={providerLabel}
          providerKey={`${state.engine.mode}:${state.engine.providerId}:${selectedProvider?.endpoint}`} metrics={metrics}
          platform={caps?.platform ?? t("Connecting…")} protocolVersion={PROTOCOL_VERSION}
          onOverlayChange={setTelemetryOverlay} />
      </main>
      {integration && (
        <Modal
          label={t("{kind} configuration", { kind: integration.kind })}
          onDismiss={() => setIntegration(null)}
        >
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                if (busy || engineOperation.current) return;
                acceptState(
                  unwrap(await api.integrationSave(integration, integrationId)),
                );
                setIntegration(null);
              });
            }}
          >
            <div className="page-title">
              <h2>{t("{kind} configuration", { kind: integration.kind })}</h2>
              <button
                type="button"
                aria-label={t("Close configuration")}
                onClick={() => setIntegration(null)}
              >
                <X />
              </button>
            </div>
            <label>
              ID
              <input
                aria-label={t("Configuration ID")}
                required
                value={integration.id}
                readOnly={!!integrationId}
                onChange={(e) =>
                  setIntegration({ ...integration, id: e.target.value })
                }
                placeholder="my-provider"
              />
            </label>
            <label>
              {t("Name")}<input
                aria-label={t("Configuration name")}
                required
                value={integration.name}
                onChange={(e) =>
                  setIntegration({ ...integration, name: e.target.value })
                }
              />
            </label>
            {integration.kind === "provider" && (
              <label>
                {t("Provider adapter")}<select
                  aria-label={t("Provider adapter")}
                  value={integration.providerType ?? "axiom"}
                  onChange={(e) => {
                    const providerType = e.target.value as MountedProviderType;
                    setIntegration({
                      ...integration,
                      providerType,
                      compatible:
                        providerType === "compatible"
                          ? { protocol: "responses" }
                          : undefined,
                      tools: [],
                      executor: "configuration-only",
                      endpoint: providerDefinitions[providerType].endpoint,
                      auth:
                        providerType === "openai"
                          ? "core-account"
                          : providerType === "xai" ||
                              providerType === "openrouter" ||
                              providerType === "anthropic" ||
                              providerType === "deepseek" ||
                              providerType === "mistral" ||
                              providerType === "gemini"
                            ? "api-key"
                            : "none",
                    });
                  }}
                >
                  <option value="axiom">Axiom</option>
                  <option value="xai">{t("xAI / Grok (API key)")}</option>
                  <option value="gemini">Google / Gemini</option>
                  <option value="deepseek">{t("DeepSeek (API key)")}</option>
                  <option value="mistral">{t("Mistral (API key)")}</option>
                  <option value="compatible">
                    {t("Custom endpoint (Responses)")}</option>
                  <option value="anthropic">
                    {t("Anthropic / Claude (API credential)")}</option>
                  <option value="openrouter">
                    {t("OpenRouter (API key or browser)")}</option>
                  <option value="openai">
                    {t("OpenAI / ChatGPT (Core account)")}</option>
                </select>
              </label>
            )}
            <label>
              {t("Endpoint")}<input
                aria-label={t("Configuration endpoint")}
                readOnly={integration.providerType === "openai"}
                value={integration.endpoint}
                onChange={(e) =>
                  setIntegration({ ...integration, endpoint: e.target.value })
                }
                placeholder="https://example.org/api"
              />
            </label>
            {integration.kind !== "provider" && (
              <label>
                {t("Executor")}<select
                  aria-label={t("Integration executor")}
                  value={integration.executor ?? "configuration-only"}
                  onChange={(e) =>
                    setIntegration({
                      ...integration,
                      executor: e.target.value as Integration["executor"],
                      tools: [],
                    })
                  }
                >
                  <option value="configuration-only">
                    {t("Configuration only (not mounted)")}</option>
                  {integration.kind === "connector" && (
                    <option value="searxng">{t("SearXNG + native web fetch")}</option>
                  )}
                  {integration.kind === "mcp" && (
                    <option value="http-mcp">{t("MCP server over HTTP")}</option>
                  )}
                </select>
              </label>
            )}
            {integration.providerType === "compatible" &&
              integration.compatible && (
                <CompatibleSettingsEditor
                  value={integration.compatible}
                  onChange={(compatible) =>
                    setIntegration({ ...integration, compatible })
                  }
                />
              )}
            <label>
              {t("Authentication method")}<select
                value={integration.auth}
                disabled={
                  integration.providerType === "openai" ||
                  integration.providerType === "xai" ||
                  integration.providerType === "openrouter" ||
                  integration.providerType === "deepseek" ||
                  integration.providerType === "mistral" ||
                  integration.providerType === "anthropic"
                }
                onChange={(e) =>
                  setIntegration({
                    ...integration,
                    auth: e.target.value as Integration["auth"],
                  })
                }
              >
                {integration.providerType === "openai" ? (
                  <option value="core-account">
                    {t("OpenAI / ChatGPT account managed by Core")}</option>
                ) : integration.providerType === "gemini" ? (
                  <>
                    <option value="api-key">
                      {t("Gemini API key (saved separately)")}</option>
                    <option value="oauth">
                      {t("Google browser login (own Desktop OAuth client)")}</option>
                  </>
                ) : integration.providerType === "xai" ||
                  integration.providerType === "openrouter" ||
                  integration.providerType === "deepseek" ||
                  integration.providerType === "mistral" ||
                  integration.providerType === "anthropic" ? (
                  <option value="api-key">
                    {t("Provider API key (saved separately, including browser-issued keys)")}</option>
                ) : (
                  <>
                    <option value="none">{t("None")}</option>
                    <option value="api-key">
                      {integration.kind === "provider"
                        ? t("Bearer token (saved separately)")
                        : t("API key (not connected)")}
                    </option>
                    {integration.providerType !== "compatible" && (
                      <option value="oauth">
                        {t("Browser sign-in (not connected)")}</option>
                    )}
                  </>
                )}
              </select>
            </label>
            <label>
              {t("Declared tools (comma-separated)")}<input
                aria-label={t("Declared tools")}
                disabled={
                  integration.providerType === "openai" ||
                  integration.providerType === "xai" ||
                  integration.providerType === "openrouter" ||
                  integration.providerType === "anthropic" ||
                  integration.providerType === "deepseek" ||
                  integration.providerType === "mistral" ||
                  integration.providerType === "compatible" ||
                  integration.providerType === "gemini" ||
                  (!!integration.executor &&
                    integration.executor !== "configuration-only")
                }
                value={integration.tools.join(",")}
                onChange={(e) =>
                  setIntegration({
                    ...integration,
                    tools: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={integration.enabled}
                onChange={(e) =>
                  setIntegration({ ...integration, enabled: e.target.checked })
                }
              />
              {t("Enable configuration (not a live connection)")}</label>
            <p className="muted">
              {t("Do not enter secrets. Selecting an executor mounts its real catalog on the next live session start/resume; declared tool names do not create capabilities. HTTP MCP OAuth uses the separate browser sign-in control. Axiom Bearer tokens are saved separately in Models & accounts after creating the provider configuration. OpenAI uses the separate Core account sign-in; its endpoint is fixed so account credentials cannot be redirected. xAI uses its own API key; changing its endpoint requires saving a credential for that exact endpoint.")}</p>
            {error && <p className="form-error">{error}</p>}
            {engineControlsBusy && (
              <p className="muted" role="status">
                {t("Wait for the current engine operation to finish before saving this configuration. Your edits are kept here.")}</p>
            )}
            <button
              className="primary"
              type="submit"
              disabled={engineControlsBusy}
            >
              {t("Save configuration")}</button>
          </form>
        </Modal>
      )}
      {workspacePrompt !== null && (
        <Modal
          label={t("Open a workspace")}
          onDismiss={() => setWorkspacePrompt(null)}
        >
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await addWorkspace(workspacePrompt);
                setWorkspacePrompt(null);
              });
            }}
          >
            <h2>{t("Open a workspace")}</h2>
            <p>
              {t("Enter a folder on the computer running the Synora service. Your browser does not grant access to files on a different computer.")}</p>
            <label>
              {t("Service folder")}<input
                aria-label={t("Service folder")}
                required
                value={workspacePrompt}
                onChange={(e) => setWorkspacePrompt(e.target.value)}
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="actions">
              <button type="button" onClick={() => setWorkspacePrompt(null)}>
                {t("Cancel")}</button>
              <button type="submit">{t("Open folder")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
