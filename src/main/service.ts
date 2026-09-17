import { basename, dirname, join } from "node:path";
import { ComputerUse } from "./computer-use";
import { ControlMcp } from "./control-mcp";
import { sampleHostMemory } from "./local-resource-metrics";
import { GpuCollectorClient } from "./gpu-collector-client";
import { workspaceOverlap } from "./workspace-lock";
import { processResourceCleanup } from "../engine/process-catalog";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { Store, preferencesSchema } from "./store";
import { AgencyCatalog } from "./agency-catalog";
import { BotCatalogUpdater } from "./bot-catalog-updater";
import { PluginDirectory } from "./plugin-directory";
import { PluginDirectoryUpdater } from "./plugin-directory-updater";
import { busySubmissionSchema, type BusySubmission } from "../shared/user-preferences";
import { EngineNotifications, LoginItemApprovalRequired, nativePreferenceCapabilities, type NativePreferenceHost } from "./native-preferences";
import { updateCompactions } from "../shared/compaction";
import { mergeMessage } from "../shared/message-history";
import { ImageAttachments } from "./image-attachments";
import * as files from "./workspace";
import { Simulator } from "../engine/simulator";
import { LiveEngine } from "../engine/live-engine";
import type { LiveOptions, LiveContext } from "../engine/live-engine";
import {
  DelegationCoordinator,
  type DelegationTask,
  type DelegationPublish,
} from "../engine/delegation-coordinator";
import { delegationTools } from "../engine/delegation-tools";
import { resolveModelSelection } from "../shared/model-selection";
import { accountProvider } from "../shared/provider-onboarding";
import {
  orchestrationPlanSchema,
  type OrchestrationPlan,
} from "../shared/orchestration";
import { AxiomStatus } from "../engine/axiom-status";
import { nativeToolSetup } from "../engine/windows-setup";
import {
  windowsCoreHome,
  type WindowsCoreHome,
} from "../engine/windows-core-home";
import { McpAuthorizationController } from "../engine/mcp-authorization";
import { CoreAccountController } from "../engine/core-account";
import { mountedProviderType } from "../shared/provider-registry";
import {
  providerDefinitions,
  providerUsesCoreModel,
} from "../shared/provider-registry";
import { OpenRouterLogin } from "../engine/openrouter-login";
import {
  mistralEndpoint,
  mistralModels,
  prepareMistralProcess,
  validateMistralSelection,
} from "../engine/mistral-provider";
import {
  compatibleEndpoint,
  compatibleModels,
  prepareCompatibleProcess,
  validateCompatibleSelection,
} from "../engine/compatible-provider";
import {
  deepSeekEndpoint,
  deepSeekModels,
  prepareDeepSeekProcess,
  validateDeepSeekSelection,
} from "../engine/deepseek-provider";
import { GoogleLogin, GoogleOAuthTransport } from "../engine/google-oauth";
import { GoogleAccounts } from "./google-accounts";
import {
  geminiEndpoint,
  geminiModels,
  prepareGeminiProcess,
  prepareGeminiWithOAuth,
  validateGeminiSelection,
} from "../engine/gemini-provider";
import {
  anthropicEndpoint,
  anthropicModels,
  prepareAnthropicProcess,
  validateAnthropicSelection,
} from "../engine/anthropic-provider";
import {
  openRouterEndpoint,
  openRouterModels,
  prepareOpenRouterProcess,
  validateOpenRouterSelection,
} from "../engine/openrouter-provider";
import { CoreUpdater, type CoreUpdaterOptions } from "../engine/core-updater";
import {
  ProviderCredentials,
  type CredentialCipher,
} from "./provider-credentials";
import {
  axiomModels,
  axiomEndpoint,
  prepareAxiomProcess,
} from "../engine/axiom-process";
import { CoreCatalogReader } from "../engine/core-catalog";
import {
  xaiEndpoint,
  xaiModels,
  prepareXaiProcess,
  validateXaiSelection,
} from "../engine/xai-provider";
import { CatalogIcons } from "../engine/catalog-icon";
import { CorePluginManager } from "../engine/core-plugin";
import {
  openAiModels,
  OPENAI_ENDPOINT,
  prepareOpenAiProcess,
  validateOpenAiSelection,
} from "../engine/openai-provider";
import { Terminals } from "./terminal";
import {
  presetSchema,
  type DesktopEvent,
  type DesktopAPI,
  type EventEnvelope,
  type PlatformCapabilities,
  type Result,
  type BrowserTab,
  type BrowserFrame,
  type BrowserInput,
  type EngineConfig,
  type Integration,
  type AppState,
} from "../shared/contracts";
import { validateOperation, type Operation } from "../shared/operations";
export interface BrowserService {
  inspect?: import("../shared/computer-use").BrowserAutomation["inspect"];
  open(url: string): BrowserTab[] | Promise<BrowserTab[]>;
  navigate(id: string, url: string): void | Promise<void>;
  action(
    id: string,
    action: "back" | "forward" | "reload" | "close",
  ): BrowserTab[] | Promise<BrowserTab[]>;
  list(): BrowserTab[];
  layout(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number },
  ): void | Promise<void>;
  frame?(id: string): Promise<BrowserFrame>;
  input?(id: string, input: BrowserInput): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface Host extends NativePreferenceHost {
  /** Host-only controlled OAuth transport; never selectable through IPC/config. */
  googleOAuthTransport?: GoogleOAuthTransport;
  /** Host dependency injection for isolated protocol qualification; never IPC/config. */
  openRouterExchange?: ConstructorParameters<
    typeof OpenRouterLogin
  >[0]["exchange"];
  credentialCipher?: CredentialCipher;
  clipboardWriteText?(text: string): void | Promise<void>;
  openAuthorizationUrl?(url: string): Promise<void>;
  closeReady(id: string, unsavedFile: boolean): void;
  capabilities: PlatformCapabilities;
  chooseWorkspace(path?: string): Promise<string | null>;
  importPreset(): Promise<unknown | null>;
  exportPreset(value: unknown, name: string): Promise<boolean>;
  browser: BrowserService;
  computer?: import("../shared/computer-use").ComputerAdapter;
}
export class LocalService {
  private control: ComputerUse;
  private controlMcp: ControlMcp;
  private agencyCatalog: AgencyCatalog;
  private botUpdates: BotCatalogUpdater;
  private pluginDirectory: PluginDirectory;
  private pluginDirectoryUpdates: PluginDirectoryUpdater;
  private disposed = false;
  private queueEpoch = 0;
  private queueTimer?: ReturnType<typeof setTimeout>;
  private drainingQueue = false;
  private notifications: EngineNotifications;
  private delegations: DelegationCoordinator;
  private workerEngines = new Map<string, LiveEngine>();
  private googleAccounts: GoogleAccounts;
  private googleLogin: GoogleLogin;
  private providerLogin: OpenRouterLogin;
  private windowsHome?: WindowsCoreHome;
  private updater: CoreUpdater;
  private runtimePaused = false;
  private runtimeCleanupFailed = false;
  private calls = 0;
  private account: CoreAccountController;
  private authorization = new McpAuthorizationController(() => {
    if (this.engine.mode === "live") this.engine.invalidateIntegrations();
  });
  private backend = new AxiomStatus();
  private gpuCollector: GpuCollectorClient;
  readonly store: Store;
  private images: ImageAttachments;
  private credentials: ProviderCredentials;
  private deletingConversation: string | null = null;
  engine: Simulator | LiveEngine;
  private configuring = false;
  private catalog = new CoreCatalogReader();
  private catalogIcons = new CatalogIcons();
  private plugins = new CorePluginManager();
  readonly terminals: Terminals;
  readonly api: Omit<DesktopAPI, "onEvent">;
  constructor(
    private path: string,
    private host: Host,
    private emit: (event: DesktopEvent) => void,
    private speed = 1,
    updaterOptions: CoreUpdaterOptions = {},
  ) {
    this.gpuCollector = new GpuCollectorClient(join(dirname(path), "gpu-collectors.json"));
    this.updater = new CoreUpdater(dirname(path), {
      notify: (message) => emit({ kind: "notice", message }),
      disabledReason: process.env.SYNORA_CODEX_BINARY
        ? "A host-supplied Core executable is active. Managed updates cannot replace an external executable."
        : undefined,
      ...updaterOptions,
    });
    this.credentials = new ProviderCredentials(
      join(dirname(path), "provider-credentials"),
      host.credentialCipher,
    );
    this.googleAccounts = new GoogleAccounts(
      join(dirname(path), "google-oauth"),
      host.credentialCipher,
      host.googleOAuthTransport,
    );
    this.googleLogin = this.makeGoogleLogin();
    this.store = new Store(path);
    this.agencyCatalog = new AgencyCatalog(join(dirname(path), "bot-catalog", "agency-agents.json"));
    this.botUpdates = new BotCatalogUpdater(this.agencyCatalog, this.store, () => emit({ kind: "resync" }));
    this.pluginDirectory = new PluginDirectory(join(dirname(path), "plugin-directory", "openai-plugins.json"));
    this.pluginDirectoryUpdates = new PluginDirectoryUpdater(this.pluginDirectory,
      () => this.store.read().preferences.pluginCatalogAutomatic !== false);
    this.images = new ImageAttachments(
      join(dirname(path), "image-attachments"),
    );
    this.updater.recoverState((s) => this.store.restoreSnapshot(s));
    try { this.images.recoverConversationRemovals(new Set(this.store.read().conversations.map(c => c.id))); }
    catch { emit({ kind: "notice", message: "Local image deletion recovery needs attention; no project files were changed." }); }
    const nativeCapabilities = nativePreferenceCapabilities(host.capabilities.platform, host);
    host.setTheme?.(this.store.read().preferences.theme ?? "system");
    if (nativeCapabilities.launchAtLogin.supported) {
      try {
        const enabled = host.launchAtLogin!.read();
        if (enabled !== this.store.read().preferences.launchAtLogin)
          this.store.preferences({ launchAtLogin: enabled });
      } catch {
        emit({ kind: "notice", message: "Synora could not read the operating system's Launch at login setting." });
      }
    }
    this.notifications = new EngineNotifications(
      () => nativeCapabilities.systemNotifications.supported && this.store.read().preferences.systemNotifications !== false,
      kind => {
        try { host.notify?.(kind); }
        catch { emit({ kind: "notice", message: "The operating system could not display a Synora notification." }); }
      },
    );
    if (process.platform === "win32")
      this.windowsHome = windowsCoreHome(this.updater.dataRoot);
    this.account = this.makeAccount();
    this.providerLogin = this.makeProviderLogin();
    this.terminals = new Terminals(emit);
    this.delegations = new DelegationCoordinator({
      load: () => this.store.read().delegations,
      save: (tasks) =>
        this.store.update((s) => {
          s.delegations = tasks;
        }),
      execute: (task, signal, publish) =>
        this.executeDelegation(task, signal, publish),
      onChange: (tasks) =>
        this.emit({
          kind: "delegations",
          tasks,
          revision: this.store.read().revision,
        }),
      resourceKey: (task) => this.workerWorkspace(task),
      resourcesConflict: workspaceOverlap,
    });
    this.control = new ComputerUse(host.browser, host.computer, () => {
      if (this.engine?.mode !== "live") return null;
      const snapshot = this.engine.snapshot();
      if (!["running", "waiting"].includes(snapshot.status) || !snapshot.conversationId || !snapshot.threadId || !snapshot.turnId) return null;
      const state = this.store.read(), conversation = state.conversations.find(c => c.id === snapshot.conversationId);
      return { conversationId: snapshot.conversationId, threadId: snapshot.threadId, turnId: snapshot.turnId,
        permission: conversation?.defaults?.permission ?? conversation?.binding?.permission ?? "ask", mode: state.preferences.mode };
    }, state => emit({ kind: "control", state }));
    this.controlMcp = new ControlMcp(this.control);
    this.engine = this.makeEngine(this.store.read().engine, 0);
    const ok =
      <T>(fn: (...args: any[]) => T | Promise<T>) =>
      async (...args: any[]): Promise<Result<T>> => {
        try {
          return { ok: true, value: await fn(...args) };
        } catch (error) {
          return {
            ok: false,
            error: {
              code: "OPERATION_FAILED",
              message:
                error instanceof Error ? error.message : "Operation failed",
            },
          };
        }
      };
    this.api = {
      controlStatus: ok(() => this.control.availability()),
      controlConfigure: ok(async (grant) => {
        if (!this.store.read().conversations.some(c => c.id === grant.conversationId)) throw Error("Unknown conversation");
        if (["running", "waiting"].includes(this.engine.snapshot().status)) throw Error("Finish the active turn before enabling control; Stop control is always available");
        await this.controlMcp.start();
        const result = await this.control.configure(grant);
        this.controlMcp.rotate();
        if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        return result;
      }),
      controlApprove: ok((id, allow) => {
        const control = this.control.snapshot(), selected = this.store.read().preferences.selectedConversationId;
        if (!control.pending || control.grant?.conversationId !== control.pending.conversationId ||
            (selected && selected !== control.pending.conversationId))
          throw Error("Return to the conversation requesting control approval");
        return this.control.approve(id, allow);
      }),
      controlStop: ok(() => this.control.stop()),
      orchestrationConfigure: ok((id, plan) =>
        this.configureOrchestration(id, plan),
      ),
      delegationCancel: ok(async (id, task) => {
        await this.delegations.cancel(task, id);
        return this.store.read();
      }),
      delegationApprove: ok(async (id, task, approval, approved) => {
        this.delegations.get(task, id);
        const engine = this.workerEngines.get(task);
        if (!engine) throw Error("Worker is not active in this Synora process");
        await engine.approve(approval, approved);
      }),
      delegationAnswer: ok(async (id, task, question, answers) => {
        this.delegations.get(task, id);
        const engine = this.workerEngines.get(task);
        if (!engine) throw Error("Worker is not active in this Synora process");
        await engine.answer(question, answers);
      }),
      coreUpdateStatus: ok(() => this.updater.snapshot()),
      coreUpdateCheck: ok(() => this.updater.check()),
      coreUpdateAutomatic: ok((enabled) => this.updater.automatic(enabled)),
      coreUpdateInstall: ok((version) =>
        this.updater.install(version, this.updateHooks()),
      ),
      coreUpdateRollback: ok((id, confirmed) => {
        if (confirmed !== true)
          throw Error("Recovery requires explicit confirmation");
        return this.updater.rollback(id, this.updateHooks());
      }),
      corePluginStatus: ok(() => this.plugins.snapshot()),
      corePluginCancel: ok((id) => this.plugins.cancel(id)),
      corePluginAuthorize: ok((reviewId, serverName) => {
        this.requireAccountIdle();
        const t = this.plugins.reviewTarget(reviewId),
          detail = this.plugins.snapshot()!.detail!;
        if (
          !detail.summary.installed ||
          !detail.summary.enabled ||
          detail.mcpServers.filter((n) => n === serverName).length !== 1
        )
          throw Error(
            "Select a declared MCP server from an installed, enabled plugin.",
          );
        const provider = this.provider(t.providerId),
          cwd = this.workspace(t.workspaceId).path;
        if (
          t.configurationIdentity !==
          this.pluginConfigurationIdentity(provider, cwd)
        )
          throw Error(
            "Provider or workspace changed after plugin review. Inspect it again before sign-in.",
          );
        return this.authorization.start({
          providerId: t.providerId,
          plugin: {
            id: t.pluginId,
            name: t.pluginName,
            remotePluginId: t.remotePluginId,
            marketplaceName: t.marketplaceName,
            marketplacePath: t.marketplacePath,
            serverName,
          },
          prepare: () => this.prepareCatalogProcess(provider, cwd),
        });
      }),
      corePluginInspect: ok(async (catalogId, marketplace, pluginId) => {
        this.requireAccountIdle();
        const t = this.catalog.pluginTarget(catalogId, marketplace, pluginId);
        const provider = this.provider(t.providerId),
          cwd = this.workspace(t.workspaceId).path;
        this.configuring = true;
        try {
          return await this.plugins.inspect(
            {
              ...t,
              configurationIdentity: this.pluginConfigurationIdentity(
                provider,
                cwd,
              ),
            },
            () => this.prepareCatalogProcess(provider, cwd),
          );
        } finally {
          this.configuring = false;
        }
      }),
      corePluginChange: ok(async (reviewId, action, confirmed) => {
        this.requireAccountIdle();
        const t = this.plugins.changeTarget(reviewId, action, confirmed);
        const provider = this.provider(t.providerId),
          cwd = this.workspace(t.workspaceId).path;
        if (
          t.configurationIdentity !==
          this.pluginConfigurationIdentity(provider, cwd)
        )
          throw Error(
            "Provider or workspace changed after plugin review. Read the catalog and inspect the plugin again.",
          );
        this.configuring = true;
        try {
          const config = this.store.read().engine;
          if (
            config.mode === "live" &&
            this.providerDirectory(this.provider(config.providerId!)) ===
              this.providerDirectory(provider)
          ) {
            const sequence = this.engine.snapshot().sequence + 1;
            await this.engine.dispose();
            this.engine = this.makeEngine(config, sequence);
            this.emit({
              kind: "engine",
              data: {
                sequence,
                at: Date.now(),
                simulated: false,
                event: { kind: "snapshot", snapshot: this.engine.snapshot() },
              },
            });
          }
          const result = await this.plugins.change(
            reviewId,
            action,
            confirmed,
            () => this.prepareCatalogProcess(provider, cwd),
          );
          if (result.mutationSent) this.catalog.invalidate();
          return result;
        } finally {
          this.configuring = false;
        }
      }),
      coreCatalogStatus: ok(() => this.catalog.snapshot()),
      pluginDirectoryRead: ok((refresh) => refresh ? this.pluginDirectory.refresh() : this.pluginDirectory.read()),
      coreCatalogIcon: ok((request) => {
        const snapshot = this.catalog.snapshot();
        const cache = snapshot
          ? join(
              this.providerDirectory(this.provider(snapshot.providerId)),
              "plugins",
              "cache",
            )
          : undefined;
        return this.catalogIcons.read(snapshot, request, cache);
      }),
      coreCatalogCancel: ok((id) => this.catalog.cancel(id)),
      coreCatalogRead: ok(async (providerId, workspaceId, remote) => {
        this.requireAccountIdle();
        const provider = this.provider(providerId);
        const cwd = this.workspace(workspaceId).path;
        this.catalogIcons.clear();
        this.configuring = true;
        try {
          return await this.catalog.read(
            { providerId, workspaceId, remote },
            () => this.prepareCatalogProcess(provider, cwd),
          );
        } finally {
          this.configuring = false;
        }
      }),
      coreAccountStatus: ok(() => this.account.snapshot()),
      coreAccountRead: ok(() => {
        this.requireAccountIdle();
        return this.account.read();
      }),
      coreAccountLogin: ok((login) =>
        this.changeCoreAccount(() => this.account.login(login)),
      ),
      coreAccountCancel: ok((id) => this.account.cancel(id)),
      coreAccountOpen: ok(async (id) => {
        if (!host.openAuthorizationUrl)
          throw new Error(
            "Use the explicit OpenAI sign-in link in your local web browser",
          );
        await host.openAuthorizationUrl(this.account.url(id));
      }),
      coreAccountLogout: ok(() =>
        this.changeCoreAccount(() => this.account.logout()),
      ),
      providerCredentialStatus: ok((id) =>
        this.credentials.status(this.credentialProvider(id)),
      ),
      providerLoginStatus: ok(() => this.providerLogin.snapshot()),
      googleAccountStatus: ok((id) =>
        this.googleAccounts.status(this.credentialProvider(id)),
      ),
      googleAccountForget: ok((id, confirmed) => {
        if (confirmed !== true)
          throw Error(
            "Removing Google configuration requires explicit confirmation",
          );
        return this.changeGoogleAccount(() =>
          this.googleAccounts.forget(this.credentialProvider(id)),
        );
      }),
      googleAccountConfigure: ok((id, client) =>
        this.changeGoogleAccount(() =>
          this.googleAccounts.configure(this.credentialProvider(id), client),
        ),
      ),
      googleAccountDisconnect: ok((id, revoke) =>
        this.changeGoogleAccount(() =>
          this.googleAccounts.disconnect(this.credentialProvider(id), revoke),
        ),
      ),
      googleLoginStatus: ok(() => this.googleLogin.snapshot()),
      googleLoginStart: ok(async (id) => {
        this.requireAccountIdle();
        this.configuring = true;
        try {
          const provider = this.provider(id),
            client = await this.googleAccounts.client(provider);
          return await this.googleLogin.start(id, client);
        } finally {
          this.configuring = false;
        }
      }),
      googleLoginCancel: ok((id) => this.googleLogin.cancel(id)),
      googleLoginOpen: ok(async (id) => {
        const pending = this.googleLogin.snapshot();
        if (
          !pending ||
          pending.id !== id ||
          pending.status !== "awaiting_authorization" ||
          !pending.authorizationUrl
        )
          throw Error("No matching Google authorization is pending");
        if (!host.openAuthorizationUrl)
          throw Error(
            "Use the Google authorization link in your local browser",
          );
        await host.openAuthorizationUrl(pending.authorizationUrl);
      }),
      providerLoginStart: ok((id, method) => {
        this.requireAccountIdle();
        const provider = this.provider(id);
        if (
          provider.providerType !== "openrouter" ||
          provider.endpoint !== providerDefinitions.openrouter.endpoint
        )
          throw Error(
            "Browser sign-in requires the official OpenRouter endpoint",
          );
        return this.providerLogin.start(id, method);
      }),
      providerLoginSubmit: ok((id, code) =>
        this.providerLogin.submit(id, code),
      ),
      providerLoginCancel: ok((id) => this.providerLogin.cancel(id)),
      providerLoginOpen: ok(async (id) => {
        const pending = this.providerLogin.snapshot();
        if (
          !pending ||
          pending.id !== id ||
          pending.status !== "awaiting_authorization" ||
          !pending.authorizationUrl
        )
          throw Error("No matching browser authorization is pending");
        if (!host.openAuthorizationUrl)
          throw Error("Use the authorization link in your local browser");
        await host.openAuthorizationUrl(pending.authorizationUrl);
      }),
      providerCredentialSave: ok((id, token) =>
        this.changeCredential(id, token),
      ),
      providerCredentialDelete: ok((id) => this.changeCredential(id)),
      mcpAuthorizationStatus: ok(() => this.authorization.snapshot()),
      mcpAuthorizationOpen: ok(async (id) => {
        if (!host.openAuthorizationUrl)
          throw new Error(
            "Use the explicit authorization link in your local web browser",
          );
        await host.openAuthorizationUrl(this.authorization.url(id));
      }),
      mcpAuthorizationCancel: ok((id) => this.authorization.cancel(id)),
      mcpAuthorize: ok((integrationId, providerId) => {
        this.requireAuthorizationIdle();
        if (
          this.configuring ||
          ["running", "waiting"].includes(this.engine.snapshot().status)
        )
          throw new Error(
            "Finish or cancel the active turn before browser sign-in",
          );
        const provider = this.provider(providerId);
        const integration = this.store
          .read()
          .integrations.find((v) => v.id === integrationId);
        if (!integration) throw new Error("Unknown MCP integration");
        return this.authorization.start({
          integration,
          providerId,
          stateDirectory: this.providerDirectory(provider),
          runtime: this.updater.selection(),
          executable: process.env.SYNORA_CODEX_BINARY,
        });
      }),
      backendStatus: ok(async () => {
        const config = this.store.read().engine;
        if (config.mode !== "live") {
          this.backend.reset();
          this.gpuCollector.reset();
          return {
            mode: "inactive" as const,
            reason:
              "Select a live Axiom provider in Settings. The simulator does not query a backend.",
          };
        }
        const provider = this.provider(config.providerId!);
        if (providerUsesCoreModel(provider.providerType)) {
          this.backend.reset();
          this.gpuCollector.reset();
          return {
            mode: "inactive" as const,
            reason: `This ${providerDefinitions[provider.providerType!].name} provider has no Axiom GPU or KV telemetry. Per-turn usage is reported separately by Core.`,
          };
        }
        const observed = await this.credentials.load(provider).then(token => this.backend.read(provider.endpoint, token));
        if (observed.mode !== "live" || observed.hardware?.state === "available") return observed;
        // Legacy collectors remain optional on older servers. Never hide an
        // authentication/TLS/schema failure behind a different hardware source.
        if (observed.hardware?.state === "unavailable" &&
            [404, 405, 501].includes(observed.hardware.httpStatus ?? 0)) {
          const gpu = await this.gpuCollector.read(provider.endpoint);
          if (gpu?.state === "available") return { ...observed, gpu };
        }
        return observed;
      }),
      closeReady: ok((id, unsavedFile) => host.closeReady(id, unsavedFile)),
      capabilities: ok(() => ({
        ...host.capabilities,
        ...nativeCapabilities,
        engine: this.engine.mode,
        liveInference: this.engine.mode === "live",
      })),
      state: ok(() => this.store.read()),
      clipboardWriteText: ok(async (text) => {
        if (!host.clipboardWriteText) throw Error("Clipboard is unavailable on this host");
        await host.clipboardWriteText(text);
      }),
      preferences: ok((p) => this.setPreferences(p)),
      chooseWorkspace: ok(async (path) => {
        const selected = await host.chooseWorkspace(path);
        if (!selected) return null;
        return this.addWorkspace(selected);
      }),
      listFiles: ok((id, p) => files.listFiles(this.workspace(id), p)),
      readFile: ok((id, p) => files.readFile(this.workspace(id), p)),
      saveFile: ok((id, doc) => files.saveFile(this.workspace(id), doc)),
      newConversation: ok((id, presetId) => this.store.conversation(id, presetId)),
      conversationUpdate: ok((id, patch) => {
        const snapshot = this.engine.snapshot();
        if (patch.archived && (((snapshot.conversationId ?? snapshot.threadId) === id && ["running", "waiting"].includes(snapshot.status)) ||
          this.store.read().conversations.find(c => c.id === id)?.queuedMessages?.some(m => m.status !== "held")))
          throw Error("Wait for the active or queued turn before archiving this conversation");
        return this.store.conversationUpdate(id, patch);
      }),
      conversationForkDraft: ok((id, confirmed) => {
        if (confirmed !== true) throw Error("Explicit confirmation required");
        const snapshot = this.engine.snapshot();
        if (this.configuring || ((snapshot.conversationId ?? snapshot.threadId) === id && ["running", "waiting"].includes(snapshot.status)))
          throw Error("Wait for the conversation operation to finish");
        return this.store.conversationForkDraft(id);
      }),
      conversationDelete: ok(async (id, confirmed) => {
        if (confirmed !== true) throw Error("Explicit confirmation required");
        if (this.disposed) throw Error("Synora is closing");
        this.requireAccountIdle();
        const target = this.store.read().conversations.find(c => c.id === id);
        if (!target) throw Error("Unknown conversation");
        const snapshot = this.engine.snapshot();
        if (target.queuedMessages?.some(m => m.status !== "held"))
          throw Error("Wait for active and queued work before deleting this conversation");
        this.configuring = true;
        try {
          this.deletingConversation = id;
          const staged = await this.images.stageConversationRemoval(id, target.attachments ?? []);
          let state: AppState;
          try {
            if ((snapshot.conversationId ?? snapshot.threadId) === id) {
              // Release only idle conversation context, not the selected provider
              // or its external history. Prevent stale events restoring the chat.
              await this.engine.dispose();
              this.engine = this.makeEngine(this.store.read().engine, snapshot.sequence + 1);
            }
            state = this.store.conversationDelete(id);
          } catch (e) { await staged.rollback(); throw e; }
          if ((snapshot.conversationId ?? snapshot.threadId) === id) {
            const next = this.engine.snapshot();
            this.emit({ kind: "engine", data: { sequence: next.sequence, at: Date.now(), simulated: this.engine.mode === "simulated",
              event: { kind: "snapshot", snapshot: next } } });
          }
          let cleanupWarning: string | undefined;
          try { await staged.purge(); } catch {
            cleanupWarning = "Conversation deleted, but some local image files could not be removed.";
          }
          this.emit({ kind: "resync" });
          return { state, ...(cleanupWarning ? { cleanupWarning } : {}) };
        } finally { this.deletingConversation = null; this.configuring = false; }
      }),
      conversationWorkspace: ok((id, workspaceId) =>
        this.store.conversationWorkspace(id, workspaceId),
      ),
      saveDraft: ok((id, text) => this.store.draft(id, text)),
      conversationPermission: ok((id, permission) => {
        this.requireAccountIdle();
        const conversation = this.store.read().conversations.find(c => c.id === id);
        const previous = conversation?.defaults?.permission ?? conversation?.binding?.permission ?? "ask";
        const state = this.store.conversationPermission(id, permission);
        if (id && previous !== permission) this.control.permissionChanged(id);
        this.emit({ kind: "resync" });
        return state;
      }),
      discardQueuedMessage: ok((conversationId, messageId) => {
        if (this.disposed) throw Error("Synora is closing");
        // Lookup, state check and removal are one synchronous transaction. This
        // may run during queue preparation, but never after the dispatch claim.
        const state = this.store.update(s => {
          const conversation = s.conversations.find(c => c.id === conversationId);
          if (!conversation) throw Error("Unknown conversation");
          const message = conversation.queuedMessages?.find(m => m.id === messageId);
          if (!message) throw Error("Queued message is missing or belongs to another conversation");
          if (message.status !== "queued" && message.status !== "held")
            throw Error("This queued message is already dispatching and cannot be discarded");
          conversation.queuedMessages = conversation.queuedMessages!.filter(m => m.id !== messageId);
        });
        this.emit({ kind: "resync" });
        return state;
      }),
      imageAttach: ok(async (id, value) => {
        this.requireAccountIdle();
        const conversation = this.store
          .read()
          .conversations.find((c) => c.id === id);
        if (!conversation) throw Error("Unknown conversation");
        this.configuring = true;
        try {
          const image = await this.images.add(id, value);
          try {
            this.store.update((s) => {
              const c = s.conversations.find((c) => c.id === id)!;
              (c.attachments ??= []).push(image);
              (c.draftImageIds ??= []).push(image.id);
            });
          } catch (error) {
            await this.images.remove(id, image);
            throw error;
          }
          return this.store.read();
        } finally {
          this.configuring = false;
        }
      }),
      imageRead: ok(async (id, imageId) => {
        if (this.deletingConversation === id) throw Error("Conversation deletion is in progress");
        const c = this.store.read().conversations.find((c) => c.id === id);
        const image = c?.attachments?.find((i) => i.id === imageId);
        if (!image) throw Error("Image is not registered in this conversation");
        return { dataUrl: (await this.images.read(id, image)).dataUrl };
      }),
      imageRemove: ok(async (id, imageId) => {
        this.requireAccountIdle();
        const c = this.store.read().conversations.find((c) => c.id === id);
        const image = c?.attachments?.find((i) => i.id === imageId);
        if (!image || !c?.draftImageIds?.includes(imageId))
          throw Error("Only a draft attachment can be removed");
        if (c.messages.some((m) => m.imageIds?.includes(imageId)))
          throw Error("Keep images belonging to sent messages");
        this.configuring = true;
        try {
          await this.images.read(id, image);
          this.store.update((s) => {
            const current = s.conversations.find((c) => c.id === id)!;
            current.draftImageIds = current.draftImageIds!.filter(
              (i) => i !== imageId,
            );
            current.attachments = current.attachments!.filter(
              (i) => i.id !== imageId,
            );
          });
          await this.images.remove(id, image);
          return this.store.read();
        } finally {
          this.configuring = false;
        }
      }),
      presetSave: ok((value, id) => this.store.preset(value, id)),
      presetInstallTemplate: ok((templateId) => this.store.installTemplate(templateId)),
      botCatalogRead: ok((refresh) => refresh ? this.botUpdates.refresh() : this.agencyCatalog.read(false)),
      botCatalogPreview: ok((id, revision) => this.agencyCatalog.preview(id, revision)),
      botCatalogImport: ok((id, confirmed) => this.store.importAgency(this.agencyCatalog.consumePreview(id, confirmed))),
      botCatalogUpdates: ok(() => this.botUpdates.status()),
      presetDelete: ok((id) =>
        this.store.update((s) => {
          if (!s.presets.some((p) => p.id === id))
            throw new Error("Unknown preset");
          s.presets = s.presets.filter((p) => p.id !== id);
          if (s.preferences.defaultBotId === id) s.preferences.defaultBotId = null;
        }),
      ),
      presetImport: ok(async () => {
        const value = await host.importPreset();
        return value === null ? null : this.store.preset(value);
      }),
      presetExport: ok(async (id) => {
        const preset = this.store.read().presets.find((p) => p.id === id);
        if (!preset) throw new Error("Unknown preset");
        const { id: _id, ...value } = preset;
        return host.exportPreset(presetSchema.parse(value), preset.name);
      }),
      integrationSave: ok((v, id) => {
        this.requireDelegationsIdle();
        this.requireAuthorizationIdle();
        if (this.configuring)
          throw new Error(
            "Wait for the active configuration or credential operation",
          );
        if (["running", "waiting"].includes(this.engine.snapshot().status))
          throw new Error(
            "Finish or cancel the active turn before changing integrations",
          );
        if (
          id &&
          this.store.read().engine.providerId === id &&
          this.engine.mode === "live"
        )
          throw new Error(
            "Disconnect this provider before changing its configuration",
          );
        const saved = this.store.integration(v, id);
        if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        return saved;
      }),
      integrationDelete: ok((id) => {
        this.requireDelegationsIdle();
        this.requireAuthorizationIdle();
        if (this.configuring)
          throw new Error(
            "Wait for the active configuration or credential operation",
          );
        const saved = this.store.update((s) => {
          if (["running", "waiting"].includes(this.engine.snapshot().status))
            throw new Error(
              "Finish or cancel the active turn before removing integrations",
            );
          if (s.engine.mode === "live" && s.engine.providerId === id)
            throw new Error("Disconnect this provider before removing it");
          if (!s.integrations.some((v) => v.id === id))
            throw new Error("Unknown integration");
          s.integrations = s.integrations.filter((v) => v.id !== id);
        });
        if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        return saved;
      }),
      engineConfigure: ok((config) => this.configure(config)),
      engineNativeSetup: ok(async (providerId, workspaceId, mode) => {
        this.requireAuthorizationIdle();
        if (
          this.configuring ||
          ["running", "waiting"].includes(this.engine.snapshot().status)
        )
          throw new Error(
            "Finish or cancel the active turn before checking native setup",
          );
        if (mode && this.engine.mode === "live")
          throw new Error(
            "Select simulator mode before changing Windows sandbox setup; existing live session history is retained",
          );
        const provider = this.provider(providerId);
        const cwd = this.workspace(workspaceId).path;
        this.configuring = true;
        try {
          return await nativeToolSetup({
            stateDirectory: this.providerDirectory(provider),
            cwd,
            mode,
            runtime: this.updater.selection(),
            executable: process.env.SYNORA_CODEX_BINARY,
          });
        } finally {
          this.configuring = false;
        }
      }),
      engineRestore: ok((id) => {
        return this.configure(this.store.read().engine, id);
      }),
      engineCompact: ok((id) => {
        this.requireAuthorizationIdle();
        if (this.configuring || this.engine.mode !== "live")
          throw Error("Select an idle live engine before compacting context");
        return this.engine.compact(id);
      }),
      engineModels: ok(async (id) => {
        this.requireAuthorizationIdle();
        if (this.configuring)
          throw new Error("Wait for the active configuration operation");
        this.configuring = true;
        try {
          return await this.inventory(this.provider(id));
        } finally {
          this.configuring = false;
        }
      }),
      engineStart: ok(async (id, text, scenario, busy?: BusySubmission) => {
        if (busy) return this.submitBusy(id, text, busySubmissionSchema.parse(busy));
        if (["running", "waiting"].includes(this.engine.snapshot().status))
          throw Error("Finish the active turn or use Send now / Queue before starting another turn");
        this.requireAuthorizationIdle();
        if (this.configuring)
          throw new Error("Engine configuration is being applied");
        const conversation = this.store
          .read()
          .conversations.find((c) => c.id === id);
        if (!conversation) throw new Error("Unknown conversation");
        if (conversation.queuedMessages?.some(m => m.status !== "held"))
          throw Error("Queued messages are pending. Wait for dispatch or cancel before starting another turn.");
        if (conversation.workspaceId)
          this.requireWorkspaceIdle(
            this.workspace(conversation.workspaceId).path,
          );
        const imageIds = conversation.draftImageIds ?? [];
        if (!text.trim() && !imageIds.length)
          throw Error("Enter a message or attach an image");
        if (imageIds.length && this.engine.mode !== "live")
          throw Error(
            "Images require a live model; the simulator cannot inspect images",
          );
        if (this.engine.mode === "simulated" && conversation.binding)
          throw new Error(
            "Open a new conversation for simulation; live history cannot be mixed with simulator output",
          );
        this.configuring = true;
        try {
          const images: Array<{ type: "localImage"; path: string }> = [];
          if (conversation.orchestration)
            await this.validateWorkerPlan(id, conversation.orchestration, true);
          for (const imageId of imageIds) {
            const image = conversation.attachments?.find(
              (i) => i.id === imageId,
            );
            if (!image) throw Error("Draft image reference is missing");
            const stored = await this.images.read(id, image);
            images.push({ type: "localImage", path: stored.path });
          }
          if (this.engine.mode === "live" &&
            (conversation.defaults?.permission ?? conversation.binding?.permission ?? "ask") === "full" &&
            await this.control.prepareFullAccess(id)) {
            await this.controlMcp.start();
            this.controlMcp.rotate();
            this.engine.invalidateIntegrations();
          }
          const snapshot =
            this.engine.mode === "live"
              ? await this.engine.start(id, text, scenario, images)
              : await this.engine.start(id, text, scenario);
          if (this.engine.mode === "simulated") this.store.draft(id, "");
          return snapshot;
        } finally {
          this.configuring = false;
        }
      }),
      engineCancel: ok(async () => {
        this.control.stop();
        this.queueEpoch++;
        this.holdQueuedMessages();
        const owner = this.engine.snapshot().conversationId;
        const cancellations = [
          this.engine.cancel(),
          ...(owner
            ? this.delegations
                .list(owner)
                .filter((t) => ["queued", "running"].includes(t.status))
                .map((t) => this.delegations.cancel(t.id, owner))
            : []),
        ];
        const settled = await Promise.allSettled(cancellations);
        const errors = settled
          .filter((r) => r.status === "rejected")
          .map((r) => r.reason);
        if (errors.length)
          throw new AggregateError(
            errors,
            "Supervisor or worker cancellation failed",
          );
        return this.engine.snapshot();
      }),
      engineApprove: ok((id, approved) => this.engine.approve(id, approved)),
      engineAnswer: ok((id, answers) => {
        if (this.engine.mode !== "live")
          throw new Error("No live user question is pending");
        return this.engine.answer(id, answers);
      }),
      engineSnapshot: ok(() => this.engine.snapshot()),
      engineReconnect: ok((after) => this.engine.reconnect(after)),
      terminalOpen: ok(async (id) => {
        const workspace = this.workspace(id);
        await files.resolveWorkspacePath(workspace, "");
        return this.terminals.open(workspace);
      }),
      terminalList: ok(() => this.terminals.list()),
      terminalWrite: ok((id, input) => this.terminals.write(id, input)),
      terminalResize: ok((id, cols, rows) =>
        this.terminals.resize(id, cols, rows),
      ),
      terminalClose: ok((id) => this.terminals.close(id)),
      browserOpen: ok((url) => host.browser.open(url)),
      browserNavigate: ok((id, url) => host.browser.navigate(id, url)),
      browserAction: ok((id, action) => host.browser.action(id, action)),
      browserList: ok(() => host.browser.list()),
      browserLayout: ok((id, rect) => host.browser.layout(id, rect)),
      browserFrame: ok((id) => {
        if (!host.browser.frame)
          throw new Error("This platform uses native browser views");
        return host.browser.frame(id);
      }),
      browserInput: ok((id, input) => {
        if (!host.browser.input)
          throw new Error("This platform uses native browser input");
        return host.browser.input(id, input);
      }),
      metrics: ok(() => ({
        hostMemory: sampleHostMemory(),
        localMemory: this.store.memoryStatus(),
        rssBytes: process.memoryUsage().rss,
        uptimeSeconds: process.uptime(),
        terminalCount: this.terminals
          .list()
          .filter((t) => t.status === "running").length,
        browserCount: host.browser.list().length,
        gpu: null,
        tokens: null,
        observedAt: Date.now(),
      })),
    };
    this.updater.start(this.updateHooks());
    this.botUpdates.start();
    this.pluginDirectoryUpdates.start();
  }
  private setPreferences(patch: Partial<AppState["preferences"]>) {
    const parsed = preferencesSchema.partial().parse(patch);
    const previous = this.store.read().preferences;
    if (parsed.defaultBotId && !this.store.read().presets.some(p => p.enabled && p.id === parsed.defaultBotId))
      throw Error("Choose an enabled saved Bot or Synora Standard");
    const capabilities = nativePreferenceCapabilities(this.host.capabilities.platform, this.host);
    if (parsed.launchAtLogin === true && !capabilities.launchAtLogin.supported)
      throw Error(capabilities.launchAtLogin.reason);
    let oldLogin: boolean | undefined;
    try {
      if (parsed.launchAtLogin !== undefined && capabilities.launchAtLogin.supported) {
        oldLogin = this.host.launchAtLogin!.read();
        this.host.launchAtLogin!.write(parsed.launchAtLogin);
      }
      if (parsed.theme !== undefined) this.host.setTheme?.(parsed.theme);
      const result = this.store.preferences(parsed);
      if (parsed.botCatalogAutomatic === true && previous.botCatalogAutomatic === false)
        void this.botUpdates.refresh().catch(() => {});
      if (parsed.pluginCatalogAutomatic === true && previous.pluginCatalogAutomatic === false)
        void this.pluginDirectoryUpdates.tick().catch(() => {});
      this.emit({ kind: "resync" });
      return result;
    } catch (error) {
      try {
        // Preserve the explicit pending OS consent request so the user can
        // approve it. Do not claim it enabled or erase that request on error.
        if (oldLogin !== undefined && !(error instanceof LoginItemApprovalRequired)) this.host.launchAtLogin!.write(oldLogin);
        if (parsed.theme !== undefined) this.host.setTheme?.(previous.theme ?? "system");
      } catch {
        this.emit({ kind: "notice", message: "An operating-system preference could not be restored. Review Synora's system settings." });
      }
      throw error;
    }
  }
  private async submitBusy(id: string, text: string, busy: BusySubmission) {
    this.requireAuthorizationIdle();
    if (this.disposed || this.configuring) throw Error("Wait for the active engine operation");
    const engine = this.engine;
    if (engine.mode !== "live") throw Error("Busy submissions require a live Core turn; simulation does not support steer or queue.");
    const snapshot = engine.snapshot();
    if (!text.trim() || text.length > 100000) throw Error("Enter a text message");
    if (snapshot.conversationId !== id || snapshot.threadId !== busy.expectedThreadId || snapshot.turnId !== busy.expectedTurnId ||
      !snapshot.sessionId || snapshot.connection !== "live" || !["running", "waiting"].includes(snapshot.status))
      throw Error("The active turn changed. The message was not submitted; review the current conversation.");
    const c = this.store.read().conversations.find(c => c.id === id);
    if (!c || c.binding?.sessionId !== snapshot.sessionId || c.binding.threadId !== snapshot.threadId)
      throw Error("No matching durable conversation binding");
    if (c.draftImageIds?.length) throw Error("Busy submissions currently support text only. Images remain in the draft.");
    if (busy.behavior === "steer") {
      this.configuring = true;
      try { return await engine.steer(id, text, busy); }
      finally { this.configuring = false; }
    }
    this.store.update(s => {
      const conversation = s.conversations.find(c => c.id === id)!;
      const messages = conversation.queuedMessages ??= [];
      if (messages.length >= 32) throw Error("The conversation queue is full. Review held messages before adding more.");
      messages.push({ id: randomUUID(), text: text.trim(), threadId: snapshot.threadId!, sessionId: snapshot.sessionId!, afterTurnId: snapshot.turnId!, status: "queued" });
      if (conversation.draft === text) conversation.draft = "";
    });
    this.emit({ kind: "resync" });
    return engine.snapshot();
  }
  private holdQueuedMessages() {
    if (!this.store.read().conversations.some(c => c.queuedMessages?.some(m => m.status !== "held"))) return;
    this.store.update(s => {
      for (const c of s.conversations)
        for (const message of c.queuedMessages ?? []) message.status = "held";
    });
    this.emit({ kind: "resync" });
    this.emit({ kind: "notice", message: "Queued messages were held for review. They were not automatically replayed." });
  }
  private scheduleQueuedMessages() {
    if (this.disposed || this.queueTimer || this.drainingQueue) return;
    if (!this.store.read().conversations.some(c => c.queuedMessages?.some(m => m.status === "queued"))) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = undefined;
      void this.drainQueuedMessage().catch(() => {
        if (!this.disposed) this.holdQueuedMessages();
      });
    }, 25);
  }
  private async drainQueuedMessage() {
    if (this.disposed || this.drainingQueue) return;
    if (this.configuring) { this.scheduleQueuedMessages(); return; }
    const engine = this.engine, snapshot = engine.snapshot(), epoch = this.queueEpoch;
    if (["running", "waiting"].includes(snapshot.status)) return;
    const c = this.store.read().conversations.find(c => c.id === snapshot.conversationId);
    const message = c?.queuedMessages?.find(m => m.status === "queued");
    if (!c || !message || engine.mode !== "live" || snapshot.status !== "completed" || snapshot.cleanupPending ||
      snapshot.connection !== "live" || snapshot.threadId !== message.threadId || snapshot.sessionId !== message.sessionId ||
      snapshot.turnId !== message.afterTurnId || c.binding?.threadId !== message.threadId || c.binding.sessionId !== message.sessionId) {
      this.holdQueuedMessages(); return;
    }
    this.requireAuthorizationIdle();
    if (c.workspaceId) this.requireWorkspaceIdle(this.workspace(c.workspaceId).path);
    this.drainingQueue = true;
    this.configuring = true;
    try {
      if (c.orchestration) await this.validateWorkerPlan(c.id, c.orchestration, true);
      if (this.disposed || epoch !== this.queueEpoch || this.engine !== engine) return;
      // A discard can win while worker validation yields. Re-resolve by queue
      // identity before claiming it; never dispatch a stale captured message.
      const currentMessage = this.store.read().conversations.find(v => v.id === c.id)
        ?.queuedMessages?.find(m => m.id === message.id);
      if (currentMessage?.status !== "queued") return;
      this.store.update(s => {
        s.conversations.find(v => v.id === c.id)!.queuedMessages!.find(m => m.id === message.id)!.status = "dispatching";
      });
      this.emit({ kind: "resync" });
      const next = await engine.start(c.id, message.text, "text");
      if (this.disposed) return;
      if (epoch !== this.queueEpoch || this.engine !== engine || !next.turnId || next.turnId === message.afterTurnId || next.threadId !== message.threadId || next.sessionId !== message.sessionId) {
        this.holdQueuedMessages(); return;
      }
      this.store.update(s => {
        const owner = s.conversations.find(v => v.id === c.id)!;
        owner.queuedMessages = owner.queuedMessages!.filter(m => m.id !== message.id);
        for (const m of owner.queuedMessages) if (m.status === "queued") m.afterTurnId = next.turnId!;
      });
      this.emit({ kind: "resync" });
    } catch {
      if (!this.disposed) this.holdQueuedMessages();
    } finally {
      this.configuring = false;
      this.drainingQueue = false;
      this.scheduleQueuedMessages();
    }
  }
  private makeAccount() {
    return new CoreAccountController({
      onAccount: (account) => {
        const provider = accountProvider(
          account?.account ?? null,
          this.store.read().integrations,
        );
        if (!provider) return;
        this.store.integration(provider);
        this.emit({ kind: "resync" });
      },
      stateDirectory:
        this.windowsHome?.path ??
        join(this.updater.dataRoot, "accounts", "openai"),
      runtime: this.updater.selection(),
      executable: process.env.SYNORA_CODEX_BINARY,
    });
  }
  private makeProviderLogin() {
    return new OpenRouterLogin({
      exchange: this.host.openRouterExchange,
      save: async (id, endpoint, key) => {
        this.requireAuthorizationIdle(true);
        if (
          this.configuring ||
          ["running", "waiting"].includes(this.engine.snapshot().status)
        )
          throw Error(
            "Finish the active operation before saving provider authorization",
          );
        const provider = this.provider(id);
        if (
          provider.providerType !== "openrouter" ||
          provider.endpoint !== endpoint ||
          provider.auth !== "api-key"
        )
          throw Error(
            "Provider configuration changed during browser authorization",
          );
        this.configuring = true;
        try {
          await this.credentials.save(provider, key);
          this.backend.reset();
          if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        } finally {
          this.configuring = false;
        }
      },
    });
  }
  private makeGoogleLogin() {
    return new GoogleLogin({
      transport: this.googleAccounts.transport,
      save: async (id, client, grant) => {
        this.requireAuthorizationIdle(false, true);
        if (
          this.configuring ||
          ["running", "waiting"].includes(this.engine.snapshot().status)
        )
          throw Error(
            "Finish the active operation before saving Google authorization",
          );
        this.configuring = true;
        try {
          await this.googleAccounts.saveGrant(this.provider(id), client, grant);
          if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        } finally {
          this.configuring = false;
        }
      },
    });
  }
  private async changeGoogleAccount<T>(action: () => Promise<T>) {
    this.requireAccountIdle();
    this.configuring = true;
    try {
      const result = await action();
      await this.googleLogin.dispose();
      this.googleLogin = this.makeGoogleLogin();
      if (this.engine.mode === "live") this.engine.invalidateIntegrations();
      return result;
    } finally {
      this.configuring = false;
    }
  }
  private googleAuthorization(provider: Integration) {
    return provider.providerType === "gemini" && provider.auth === "oauth"
      ? (signal: AbortSignal) =>
          this.googleAccounts.access(this.provider(provider.id), signal)
      : undefined;
  }
  private async providerAuthorization(provider: Integration) {
    const oauth = this.googleAuthorization(provider);
    return oauth
      ? (await oauth(AbortSignal.timeout(15000))).accessToken
      : this.credentials.load(provider);
  }
  private geminiPrepare(provider: Integration) {
    const oauth = this.googleAuthorization(provider);
    return oauth ? prepareGeminiWithOAuth(oauth) : prepareGeminiProcess;
  }
  private updateHooks() {
    return {
      idle: () => {
        this.requireAccountIdle();
        if (this.calls > 1)
          throw Error(
            "Wait for pending Synora operations before updating Core",
          );
        if (
          this.store
            .read()
            .agentHistory.some(
              (a) => !a.closed && ["running", "pendingInit"].includes(a.status),
            )
        )
          throw Error(
            "Finish and close active child agents before updating Core",
          );
      },
      pause: async () => {
        this.runtimePaused = true;
        this.runtimeCleanupFailed = true;
        await this.engine.dispose();
        await this.account.dispose();
        await this.catalog.dispose();
        await this.plugins.dispose();
        await this.authorization.dispose();
        await this.providerLogin.dispose();
        await this.googleLogin.dispose();
        this.catalogIcons.clear();
        this.runtimeCleanupFailed = false;
      },
      state: () => this.store.read(),
      restore: (s: unknown) => this.store.restoreSnapshot(s),
      resume: () => {
        if (!this.runtimePaused) return;
        if (this.runtimeCleanupFailed)
          throw Error(
            "Owned Core cleanup failed; restart Synora before resuming. No replacement process was started.",
          );
        this.updater.recoverState((s) => this.store.restoreSnapshot(s));
        if (process.platform === "win32")
          this.windowsHome = windowsCoreHome(this.updater.dataRoot);
        this.account = this.makeAccount();
        this.providerLogin = this.makeProviderLogin();
        this.googleLogin = this.makeGoogleLogin();
        this.catalog = new CoreCatalogReader();
        this.plugins = new CorePluginManager();
        this.authorization = new McpAuthorizationController(() => {
          if (this.engine.mode === "live") this.engine.invalidateIntegrations();
        });
        this.engine = this.makeEngine(
          this.store.read().engine,
          this.engine.snapshot().sequence + 1,
        );
        this.runtimePaused = false;
        this.emit({ kind: "resync" });
      },
    };
  }
  private provider(id: string) {
    const p = this.store
      .read()
      .integrations.find((v) => v.id === id && v.kind === "provider");
    if (!p || !p.enabled) throw new Error("Select an enabled provider");
    const type = mountedProviderType(p.providerType);
    if (type === "openai") {
      if (p.endpoint !== OPENAI_ENDPOINT || p.auth !== "core-account")
        throw new Error("Invalid OpenAI account routing");
      return p;
    }
    if (type === "xai") {
      if (p.auth !== "api-key")
        throw Error("xAI requires its own saved API key");
      return { ...p, endpoint: xaiEndpoint(p.endpoint) };
    }
    if (type === "openrouter") {
      if (p.auth !== "api-key")
        throw Error(
          "OpenRouter requires an endpoint-scoped API key or browser-issued key",
        );
      return { ...p, endpoint: openRouterEndpoint(p.endpoint) };
    }
    if (type === "anthropic") {
      if (p.auth !== "api-key")
        throw Error("Anthropic requires its own saved Claude API credential");
      return { ...p, endpoint: anthropicEndpoint(p.endpoint) };
    }
    if (type === "gemini") {
      if (p.auth !== "api-key" && p.auth !== "oauth")
        throw Error(
          "Gemini requires a saved API key or its own Google OAuth account",
        );
      return { ...p, endpoint: geminiEndpoint(p.endpoint) };
    }
    if (type === "deepseek") {
      if (p.auth !== "api-key")
        throw Error("DeepSeek requires its own saved API key");
      return { ...p, endpoint: deepSeekEndpoint(p.endpoint) };
    }
    if (type === "mistral") {
      if (p.auth !== "api-key")
        throw Error("Mistral requires its own saved API key");
      return { ...p, endpoint: mistralEndpoint(p.endpoint) };
    }
    if (type === "compatible") {
      if (!["none", "api-key"].includes(p.auth) || !p.compatible)
        throw Error(
          "Select Responses compatibility and anonymous or API-key authentication",
        );
      return { ...p, endpoint: compatibleEndpoint(p.endpoint) };
    }
    if (p.auth !== "none" && p.auth !== "api-key")
      throw new Error(
        "Axiom supports no authentication or a saved Bearer token; provider OAuth is not mounted",
      );
    return { ...p, endpoint: axiomEndpoint(p.endpoint) };
  }
  private pluginConfigurationIdentity(provider: Integration, cwd: string) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider,
          cwd,
          integrations: this.store
            .read()
            .integrations.filter((v) => v.kind !== "provider"),
        }),
      )
      .digest("hex");
  }
  private async prepareCatalogProcess(provider: Integration, cwd: string) {
    // Metadata and plugin management must not probe the inference endpoint or
    // require a model/effort selection. Preserve this profile's own Core home;
    // there is no account copying and no thread/start or model turn here.
    return prepareOpenAiProcess({
      cwd,
      stateDirectory: this.providerDirectory(provider),
      runtime: this.updater.selection(),
      executable: process.env.SYNORA_CODEX_BINARY,
      integrations: this.store
        .read()
        .integrations.filter((v) => v.kind !== "provider"),
      endpoint: OPENAI_ENDPOINT,
      model: "",
      profile: "",
      context: null,
    });
  }
  private providerDirectory(provider: Integration) {
    if (this.windowsHome?.error) throw Error(this.windowsHome.error);
    if (this.windowsHome) return this.windowsHome.path;
    return provider.providerType === "openai"
      ? join(this.updater.dataRoot, "accounts", "openai")
      : join(this.updater.dataRoot, "app-server", provider.id);
  }
  private async inventory(
    provider: Integration,
  ): Promise<import("../shared/contracts").ModelCapabilities[]> {
    return provider.providerType === "openai"
      ? openAiModels({
          stateDirectory: this.providerDirectory(provider),
          runtime: this.updater.selection(),
          executable: process.env.SYNORA_CODEX_BINARY,
        })
      : this.providerAuthorization(provider).then<
          import("../shared/contracts").ModelCapabilities[]
        >((token) =>
          provider.providerType === "xai"
            ? xaiModels(provider.endpoint, token)
            : provider.providerType === "openrouter"
              ? openRouterModels(provider.endpoint, token)
              : provider.providerType === "anthropic"
                ? anthropicModels(provider.endpoint, token)
                : provider.providerType === "gemini"
                  ? geminiModels(
                      provider.endpoint,
                      token,
                      this.googleAuthorization(provider),
                    )
                  : provider.providerType === "deepseek"
                    ? deepSeekModels(provider.endpoint, token)
                    : provider.providerType === "mistral"
                      ? mistralModels(provider.endpoint, token)
                      : provider.providerType === "compatible"
                        ? compatibleModels(
                            provider.endpoint,
                            token,
                            provider.compatible,
                          )
                        : axiomModels(provider.endpoint, token),
        );
  }
  private async changeCoreAccount<T>(action: () => T | Promise<T>): Promise<T> {
    this.requireAccountIdle();
    this.configuring = true;
    try {
      const config = this.store.read().engine;
      if (
        config.mode === "live" &&
        (this.windowsHome ||
          this.provider(config.providerId!).providerType === "openai")
      ) {
        const sequence = this.engine.snapshot().sequence + 1;
        await this.engine.dispose();
        this.engine = this.makeEngine(config, sequence);
        this.emit({
          kind: "engine",
          data: {
            sequence,
            at: Date.now(),
            simulated: false,
            event: { kind: "snapshot", snapshot: this.engine.snapshot() },
          },
        });
      }
      return await action();
    } finally {
      this.configuring = false;
    }
  }
  private requireAuthorizationIdle(
    committingProviderLogin = false,
    committingGoogleLogin = false,
  ) {
    if (!committingGoogleLogin && this.googleLogin?.busy)
      throw Error("Finish or cancel the pending Google sign-in first");
    if (!committingProviderLogin && this.providerLogin?.busy)
      throw Error(
        "Finish or cancel the pending provider browser sign-in first",
      );
    if (this.windowsHome?.error) throw Error(this.windowsHome.error);
    if (this.runtimePaused)
      throw Error(
        "Core runtime recovery is pending; restart Synora before resuming",
      );
    if (this.updater.busy)
      throw Error("App Server update is in progress; wait for completion");
    if (this.plugins.busy)
      throw Error(
        "Finish or cancel the plugin operation and owned cleanup first",
      );
    if (this.catalog.busy)
      throw new Error("Finish or cancel the catalog read and cleanup first");
    if (this.engine.snapshot().cleanupPending)
      throw new Error("Wait for the owned turn cleanup to finish");
    if (this.account.busy)
      throw new Error("Finish or cancel the pending account operation first");
    if (this.authorization.busy)
      throw new Error("Finish or cancel the pending browser sign-in first");
  }
  private requireAccountIdle() {
    this.requireAuthorizationIdle();
    this.requireDelegationsIdle();
    if (
      this.configuring ||
      ["running", "waiting"].includes(this.engine.snapshot().status)
    )
      throw new Error(
        "Finish or cancel the active turn before changing account state",
      );
  }
  private credentialProvider(id: string) {
    const provider = this.store
      .read()
      .integrations.find((v) => v.id === id && v.kind === "provider");
    if (!provider) throw new Error("Unknown provider");
    const type = mountedProviderType(provider.providerType);
    if (type === "openai")
      throw Error(
        "Manage OpenAI credentials through its original Core account",
      );
    return {
      ...provider,
      endpoint:
        type === "xai"
          ? xaiEndpoint(provider.endpoint)
          : type === "openrouter"
            ? openRouterEndpoint(provider.endpoint)
            : type === "anthropic"
              ? anthropicEndpoint(provider.endpoint)
              : type === "gemini"
                ? geminiEndpoint(provider.endpoint)
                : type === "deepseek"
                  ? deepSeekEndpoint(provider.endpoint)
                  : type === "mistral"
                    ? mistralEndpoint(provider.endpoint)
                    : type === "compatible"
                      ? compatibleEndpoint(provider.endpoint)
                      : axiomEndpoint(provider.endpoint),
    };
  }
  private async changeCredential(id: string, token?: string) {
    this.requireDelegationsIdle();
    this.requireAuthorizationIdle();
    if (
      this.configuring ||
      ["running", "waiting"].includes(this.engine.snapshot().status)
    )
      throw new Error(
        "Finish or cancel the active turn before changing provider credentials",
      );
    this.configuring = true;
    try {
      const provider = this.credentialProvider(id);
      const result =
        token === undefined
          ? await this.credentials.remove(provider)
          : await this.credentials.save(provider, token);
      this.backend.reset();
      if (this.engine.mode === "live") this.engine.invalidateIntegrations();
      return result;
    } finally {
      this.configuring = false;
    }
  }
  private controlIntegrations(values: Integration[]) {
    return [...values.filter(v => v.kind !== "provider" && v.id !== "internal-computer-use"),
      ...(this.controlMcp.integration ? [this.controlMcp.integration] : [])];
  }
  private makeEngine(
    config: EngineConfig,
    initialSequence: number,
    hooks: Partial<Pick<LiveOptions, "context" | "bind" | "sink">> = {},
  ) {
    if (config.mode === "simulated")
      return new Simulator(
        (data) => this.emit({ kind: "engine", data }),
        this.speed,
        (event) => this.persistEngine(event),
        initialSequence,
      );
    // An isolated App Server state directory per provider keeps resumable thread
    // identities separate from other Codex applications and account credentials.
    const provider = this.provider(config.providerId!);
    return new LiveEngine(
      {
        ...(provider.providerType === "openai"
          ? { provider: "openai" as const }
          : {
              ...(provider.providerType === "xai"
                ? { provider: "synora_xai" as const }
                : provider.providerType === "openrouter"
                  ? { provider: "synora_openrouter" as const }
                  : provider.providerType === "anthropic"
                    ? { provider: "synora_anthropic" as const }
                    : provider.providerType === "gemini"
                      ? { provider: "synora_gemini" as const }
                      : provider.providerType === "deepseek"
                        ? { provider: "synora_deepseek" as const }
                        : provider.providerType === "mistral"
                          ? { provider: "synora_mistral" as const }
                          : provider.providerType === "compatible"
                            ? { provider: "synora_compatible" as const }
                            : {}),
              authorization: () =>
                this.providerAuthorization(this.provider(provider.id)),
            }),
        executable: process.env.SYNORA_CODEX_BINARY,
        runtime: this.updater.selection(),
        stateDirectory: this.providerDirectory(provider),
        endpoint: provider.endpoint,
        model: config.model!,
        initialSequence,
        // Only the foreground installation engine stays resident. Workers keep
        // their existing task-scoped ownership and must still exit on disposal.
        ...(Object.keys(hooks).length === 0
          ? {
              persistent: {
                allowed: () =>
                  !this.runtimePaused &&
                  !this.configuring &&
                  !this.updater.busy &&
                  !this.account.busy &&
                  !this.providerLogin.busy &&
                  !this.googleLogin.busy &&
                  !this.plugins.busy &&
                  !this.catalog.busy &&
                  !this.authorization.busy,
                context: async () => {
                  const s = this.store.read();
                  const cwd = join(
                    this.providerDirectory(provider),
                    ".synora-idle",
                  );
                  await mkdir(cwd, { recursive: true, mode: 0o700 });
                  return {
                    cwd,
                    profile: providerUsesCoreModel(provider.providerType)
                      ? (config.reasoningEffort ?? "")
                      : s.preferences.profile,
                    context: providerUsesCoreModel(provider.providerType)
                      ? null
                      : s.preferences.context,
                    mode: s.preferences.mode,
                    integrations: this.controlIntegrations(s.integrations),
                  };
                },
              },
            }
          : {}),
        context: (id) => {
          const s = this.store.read(),
            c = s.conversations.find((v) => v.id === id);
          if (!c?.workspaceId)
            throw new Error(
              "Choose a workspace before starting a live conversation",
            );
          if (c.messages.some((m) => m.simulated))
            throw new Error(
              "Open a new conversation for live work; simulator history cannot be resumed as real history",
            );
          const cwd = this.workspace(c.workspaceId).path;
          if (c.binding && c.binding.cwd !== cwd)
            throw new Error(
              "This live conversation belongs to its original workspace",
            );
          return {
            ...(c.orchestration
              ? {
                  hostTools: delegationTools(
                    id,
                    c.orchestration.workers,
                    this.delegations,
                  ),
                }
              : {}),
            cwd,
            profile: providerUsesCoreModel(provider.providerType)
              ? (s.engine.reasoningEffort ?? "")
              : s.preferences.profile,
            mode: s.preferences.mode,
            context: providerUsesCoreModel(provider.providerType)
              ? null
              : s.preferences.context,
            binding: c.binding,
            botInstructions: c.defaults?.bot?.instructions,
            permission: c.defaults?.permission ?? c.binding?.permission ?? "ask",
            usageHistory: c.usage,
            backendHistory: c.backendRequests,
            compactionHistory: c.compactions,
            agentHistory: s.agentHistory.filter(
              (a) => !a.simulated && a.parentId === c.binding?.threadId,
            ),
            integrations: this.controlIntegrations(s.integrations),
          };
        },
        bind: (id, binding) => {
          this.store.update((s) => {
            const c = s.conversations.find((v) => v.id === id);
            if (!c) throw new Error("Unknown conversation");
            c.binding = binding;
          });
        },
        sink: (data) => {
          this.persistEngine(data);
          this.emit({ kind: "engine", data });
        },
        ...hooks,
      },
      provider.providerType === "openai"
        ? prepareOpenAiProcess
        : provider.providerType === "xai"
          ? prepareXaiProcess
          : provider.providerType === "openrouter"
            ? prepareOpenRouterProcess
            : provider.providerType === "anthropic"
              ? prepareAnthropicProcess
              : provider.providerType === "gemini"
                ? this.geminiPrepare(provider)
                : provider.providerType === "deepseek"
                  ? prepareDeepSeekProcess
                  : provider.providerType === "mistral"
                    ? prepareMistralProcess
                    : provider.providerType === "compatible"
                      ? (options: Parameters<typeof prepareAxiomProcess>[0]) =>
                          prepareCompatibleProcess(
                            options,
                            provider.compatible!,
                          )
                      : undefined,
    );
  }
  private requireDelegationsIdle() {
    if (
      this.delegations
        ?.list()
        .some((t) => ["queued", "running"].includes(t.status))
    )
      throw Error(
        "Finish or cancel delegated workers before changing providers, credentials or runtime",
      );
  }
  private workerWorkspace(task: DelegationTask) {
    const s = this.store.read(),
      worker = s.conversations
        .find((c) => c.id === task.parentConversationId)
        ?.orchestration?.workers.find((w) => w.id === task.workerId);
    const path = s.workspaces.find((w) => w.id === worker?.workspaceId)?.path;
    if (!path) throw Error("Delegated worker has no registered workspace");
    return path;
  }
  private requireWorkspaceIdle(path: string) {
    if (
      this.delegations
        .list()
        .some(
          (t) =>
            ["queued", "running"].includes(t.status) &&
            workspaceOverlap(path, this.workerWorkspace(t)),
        )
    )
      throw Error(
        "This workspace overlaps an active delegated worker; wait for cleanup or choose a separate workspace",
      );
  }
  private async validateWorkerPlan(
    owner: string,
    plan: OrchestrationPlan,
    existing = false,
  ) {
    const s = this.store.read(),
      conversation = s.conversations.find((c) => c.id === owner);
    if (!conversation?.workspaceId)
      throw Error("Choose the supervisor workspace first");
    const paths = [
      await realpath(this.workspace(conversation.workspaceId).path),
    ];
    const catalogs = new Map<string, ReturnType<LocalService["inventory"]>>();
    const workers = [];
    for (const worker of plan.workers) {
      const provider = this.provider(worker.selection.providerId);
      if (!catalogs.has(provider.id))
        catalogs.set(provider.id, this.inventory(provider));
      const selection = resolveModelSelection(
        worker.selection,
        provider.providerType,
        await catalogs.get(provider.id)!,
      );
      const path = await realpath(this.workspace(worker.workspaceId).path);
      for (const existing of paths) {
        if (workspaceOverlap(existing, path))
          throw Error(
            "Each worker must have a separate, non-overlapping workspace, distinct from the supervisor",
          );
      }
      paths.push(path);
      const contractHash = createHash("sha256")
        .update(
          JSON.stringify({
            providerId: provider.id,
            type: provider.providerType ?? "axiom",
            endpoint: provider.endpoint,
            auth: provider.auth,
            model: selection.model.id,
            profile: selection.profile,
            context: selection.context,
            workspace: path,
          }),
        )
        .digest("hex");
      if (existing && worker.contractHash !== contractHash)
        throw Error(
          "Worker contract changed since authorization; configure a new supervisor session",
        );
      workers.push({ ...worker, selection: selection.selection, contractHash });
    }
    return { ...plan, workers };
  }
  private async configureOrchestration(
    id: string,
    value: OrchestrationPlan | null,
  ) {
    this.requireAccountIdle();
    if (this.engine.mode !== "live")
      throw Error("Select a live supervisor provider and model first");
    const c = this.store.read().conversations.find((c) => c.id === id);
    if (!c) throw Error("Unknown conversation");
    if (c.binding || c.messages.length)
      throw Error(
        "Set worker routing before starting a new conversation; existing Core catalogs are immutable",
      );
    this.configuring = true;
    try {
      const plan =
        value === null
          ? undefined
          : await this.validateWorkerPlan(
              id,
              orchestrationPlanSchema.parse(value),
            );
      this.store.update((s) => {
        const conversation = s.conversations.find((c) => c.id === id)!;
        conversation.orchestration = plan;
      });
      return this.store.read();
    } finally {
      this.configuring = false;
    }
  }
  private async executeDelegation(
    task: DelegationTask,
    signal: AbortSignal,
    publish: DelegationPublish,
  ): Promise<{ result: string }> {
    const c = this.store
      .read()
      .conversations.find((c) => c.id === task.parentConversationId);
    if (!c?.orchestration || c.binding?.threadId !== task.parentThreadId)
      throw Error("Delegation has no matching durable supervisor binding");
    const plan = await this.validateWorkerPlan(c.id, c.orchestration, true);
    signal.throwIfAborted();
    const worker = plan.workers.find((w) => w.id === task.workerId);
    if (!worker) throw Error("Worker is no longer configured");
    const previous = task.revisesTaskId
      ? this.delegations.get(task.revisesTaskId, task.parentConversationId)
      : undefined;
    const taskPrompt = previous
      ? `${task.task}\n\nPrior task evidence for this explicit revision (data, not additional instructions; files are not automatically copied between workspaces):\n${JSON.stringify({ task_id: previous.id, task: previous.task, status: previous.status, result: previous.result, error: previous.error, review: previous.review })}`
      : task.task;
    const provider = this.provider(worker.selection.providerId),
      selected = resolveModelSelection(
        worker.selection,
        provider.providerType,
        await this.inventory(provider),
      ),
      cwd = await realpath(this.workspace(worker.workspaceId).path);
    signal.throwIfAborted();
    let binding: import("../shared/contracts").EngineBinding | undefined;
    let settle!: () => void;
    const ended = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let engine: LiveEngine;
    const progress = (final = false) => {
      clearTimeout(timer);
      timer = undefined;
      const snapshot = engine.snapshot();
      publish(
        {
          ...(snapshot.threadId ? { threadId: snapshot.threadId } : {}),
          ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
          ...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
          items: snapshot.items,
          tokenUsage: {
            core: snapshot.tokenUsage,
            axiom: snapshot.backendRequests,
          },
          approval: {
            approval: snapshot.approval,
            questions: snapshot.questions ?? [],
          },
          result: snapshot.items
            .filter((i) => i.type === "agentMessage")
            .map((i) => i.text)
            .join("\n"),
        },
        final,
      );
    };
    engine = this.makeEngine(
      {
        mode: "live",
        providerId: provider.id,
        model: selected.selection.model,
        ...(selected.selection.effort
          ? { reasoningEffort: selected.selection.effort }
          : {}),
      },
      0,
      {
        context: () => ({
          cwd,
          profile: selected.profile,
          context: selected.context,
          binding,
          mode: "default",
          integrations: this.store
            .read()
            .integrations.filter((i) => i.kind !== "provider"),
        }),
        bind: (_id, value) => {
          binding = value;
          publish({ threadId: value.threadId, sessionId: value.sessionId });
        },
        sink: () => {
          const status = engine.snapshot().status;
          if (
            ["completed", "failed", "interrupted", "disconnected"].includes(
              status,
            )
          ) {
            progress();
            settle();
          } else if (!timer) timer = setTimeout(progress, 120);
        },
      },
    ) as LiveEngine;
    this.workerEngines.set(task.id, engine);
    // Signal cancellation wakes this executor, then dispose awaits owned cleanup.
    const abort = () => settle();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const starting = engine.start(task.id, taskPrompt, "text");
      const abortStartup = () => {
        void engine.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abortStartup, { once: true });
      try {
        await starting;
      } finally {
        signal.removeEventListener("abort", abortStartup);
      }
      if (!["running", "waiting"].includes(engine.snapshot().status)) settle();
      await ended;
      signal.throwIfAborted();
      const done = engine.snapshot();
      if (done.status !== "completed" || done.error)
        throw Error(done.error?.message ?? `Worker ended with ${done.status}`);
      const result = done.items
        .filter((i) => i.type === "agentMessage")
        .map((i) => i.text)
        .join("\n");
      if (!result.trim())
        throw Error("Worker completed without a reviewable answer");
      return { result };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        await engine.dispose();
      } finally {
        try {
          progress(true);
        } finally {
          this.workerEngines.delete(task.id);
        }
      }
    }
  }
  private restoreConfiguration(id: string): EngineConfig {
    const s = this.store.read(), c = s.conversations.find(c => c.id === id);
    if (!c?.binding) throw Error("This conversation has no live session to restore");
    if (!c.workspaceId || this.workspace(c.workspaceId).path !== c.binding.cwd)
      throw Error("This live conversation belongs to its original workspace");
    if (c.messages.some(m => m.simulated))
      throw Error("Simulator history cannot be restored as a live session");
    this.requireWorkspaceIdle(c.binding.cwd);
    const endpoint = (url: string) => { try { return new URL(url).href.replace(/\/$/, ""); } catch { return null; } };
    // Existing bindings retain endpoint/model/cwd, not a configured account ID.
    // Require a unique original endpoint owner, including disabled duplicates;
    // do not guess a Core home or migrate protected history just to open it.
    const candidates = s.integrations.filter(p => p.kind === "provider" &&
      endpoint(p.endpoint) === c.binding!.endpoint);
    if (!candidates.length)
      throw Error("The saved conversation's provider is missing. Restore its original provider configuration before retrying.");
    if (candidates.length !== 1)
      throw Error("The saved conversation's provider identity is ambiguous. Resolve duplicate provider configurations before retrying; history is preserved.");
    const provider = this.provider(candidates[0].id);
    if (provider.endpoint !== c.binding.endpoint)
      throw Error("The saved conversation's provider endpoint has changed. Restore its original endpoint before retrying.");
    // Explicit effort changes on the same selected provider/model still apply.
    if (s.engine.providerId === provider.id && s.engine.model === c.binding.model)
      return s.engine;
    // No cross-provider effort carryover. The target catalog supplies its own
    // default, while Axiom keeps its separate existing profile/context controls.
    return { mode: "live", providerId: provider.id, model: c.binding.model };
  }
  private async configure(config: EngineConfig, restoreId?: string) {
    this.requireAuthorizationIdle();
    this.requireDelegationsIdle();
    if (
      this.configuring ||
      ["running", "waiting"].includes(this.engine.snapshot().status)
    )
      throw new Error(
        "Finish or cancel the active turn before changing engines",
      );
    this.configuring = true;
    try {
      if (restoreId !== undefined) {
        if (this.engine.mode !== "live")
          throw Error("Select a live engine before restoring a session");
        config = this.restoreConfiguration(restoreId);
        if (JSON.stringify(config) === JSON.stringify(this.store.read().engine))
          return await this.engine.restore(restoreId);
      }
      if (config.mode === "live") {
        const provider = this.provider(config.providerId!);
        const inventory = await this.inventory(provider);
        if (!inventory.some((m) => m.id === config.model))
          throw new Error("Selected model is not advertised by the provider");
        if (providerUsesCoreModel(provider.providerType)) {
          const selected = (
            provider.providerType === "xai"
              ? validateXaiSelection
              : provider.providerType === "openrouter"
                ? validateOpenRouterSelection
                : provider.providerType === "anthropic"
                  ? validateAnthropicSelection
                  : provider.providerType === "gemini"
                    ? validateGeminiSelection
                    : provider.providerType === "deepseek"
                      ? validateDeepSeekSelection
                      : provider.providerType === "mistral"
                        ? validateMistralSelection
                        : provider.providerType === "compatible"
                          ? validateCompatibleSelection
                          : validateOpenAiSelection
          )(inventory, config.model!, config.reasoningEffort);
          config = {
            ...config,
            reasoningEffort:
              config.reasoningEffort ?? selected.default_reasoning_effort,
          };
        } else if (config.reasoningEffort !== undefined)
          throw new Error(
            "Axiom uses its separately selected reasoning profile",
          );
      }
      const sequence = this.engine.snapshot().sequence + 1;
      const next = this.makeEngine(config, sequence);
      try { await this.engine.dispose(); }
      catch (error) { await next.dispose(); throw error; }
      this.store.update((s) => {
        s.engine = config;
      });
      this.engine = next;
      this.backend.reset();
      const snapshot = next.snapshot();
      this.emit({
        kind: "engine",
        data: {
          sequence,
          at: Date.now(),
          simulated: config.mode === "simulated",
          event: { kind: "snapshot", snapshot },
        },
      });
      return restoreId !== undefined
        ? await (next as LiveEngine).restore(restoreId) : snapshot;
    } finally {
      this.configuring = false;
      if (restoreId !== undefined) this.emit({ kind: "resync" });
    }
  }
  async addWorkspace(selected: string) {
    const root = await realpath(selected);
    if (!(await stat(root)).isDirectory())
      throw new Error("Choose a directory");
    return this.store.addWorkspace(root, basename(root) || root);
  }
  private workspace(id: string) {
    const workspace = this.store.read().workspaces.find((w) => w.id === id);
    if (!workspace) throw new Error("Unknown workspace");
    return workspace;
  }
  private persistEngine(envelope: EventEnvelope) {
    const e = envelope.event;
    if (!envelope.simulated && e.kind === "snapshot") {
      if (["failed", "interrupted"].includes(e.snapshot.status)) this.holdQueuedMessages();
      else if (e.snapshot.status === "completed") this.scheduleQueuedMessages();
    }
    if (!envelope.simulated) {
      if (e.kind === "snapshot") this.notifications.observe(e.snapshot);
      if (e.kind === "connection" && this.engine)
        this.notifications.observe({ ...this.engine.snapshot(), connection: e.state, appServer: e.appServer });
    }
    if (e.kind === "snapshot" && e.snapshot.usage && !envelope.simulated) {
      const usage = e.snapshot.usage;
      const current = this.store.read().conversations.find(c => c.id === envelope.conversationId);
      if (current?.binding?.threadId === usage.threadId &&
          (!current.usage || (current.usage.observedAt <= usage.observedAt &&
            JSON.stringify(current.usage) !== JSON.stringify(usage)))) {
        this.store.update(s => {
          const c = s.conversations.find(c => c.id === envelope.conversationId);
          if (c?.binding?.threadId === usage.threadId) c.usage = usage;
        });
      }
    }
    if (
      e.kind === "snapshot" &&
      ["failed", "interrupted"].includes(e.snapshot.status) &&
      envelope.conversationId
    ) {
      const owner = envelope.conversationId;
      for (const task of this.delegations
        .list(owner)
        .filter((t) => ["queued", "running"].includes(t.status)))
        void this.delegations.cancel(task.id, owner).catch((error) =>
          this.emit({
            kind: "notice",
            message: `Worker cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
          }),
        );
    }
    if (e.kind === "snapshot" && e.snapshot.compactions?.length) {
      this.store.update((s) => {
        const c = s.conversations.find((c) => c.id === envelope.conversationId);
        if (!c?.binding || envelope.simulated) return;
        c.compactions = e.snapshot.compactions!.filter(
          (r) => r.threadId === c.binding!.threadId,
        );
      });
    }
    if (e.kind === "backend-metrics") {
      if (envelope.simulated)
        throw new Error("Simulated events cannot store Axiom measurements");
      this.store.update((s) => {
        const c = s.conversations.find((c) => c.id === envelope.conversationId);
        if (
          !c?.binding ||
          c.binding.threadId !== e.metrics.threadId ||
          c.binding.sessionId !== e.metrics.sessionId
        )
          throw new Error(
            "Axiom measurement identity does not match the conversation",
          );
        c.backendRequests ??= [];
        if (
          !c.backendRequests.some(
            (v) =>
              v.responseId === e.metrics.responseId &&
              v.turnId === e.metrics.turnId &&
              v.sessionId === e.metrics.sessionId,
          )
        )
          c.backendRequests.push(e.metrics);
      });
      return;
    }
    if (e.kind === "agents") {
      if (e.agents.length)
        this.store.update((s) => {
          for (const agent of e.agents) {
            const c = s.conversations.find(
              (v) => v.id === envelope.conversationId,
            );
            if (
              agent.simulated !== envelope.simulated ||
              (!agent.simulated &&
                (!c?.binding ||
                  agent.parentId !== c.binding.threadId ||
                  agent.backendRequests?.some(
                    (m) =>
                      m.threadId !== agent.id ||
                      m.sessionId !== c.binding!.sessionId,
                  )))
            )
              throw new Error(
                "Agent identity/measurement does not match its owning conversation",
              );
            const i = s.agentHistory.findIndex((a) => a.id === agent.id);
            if (i < 0) s.agentHistory.push(agent);
            else s.agentHistory[i] = agent;
          }
        });
      return;
    }
    const terminalSnapshot =
      e.kind === "snapshot" &&
      ["failed", "interrupted", "disconnected"].includes(e.snapshot.status);
    if (e.kind !== "protocol" && e.kind !== "history" && !terminalSnapshot)
      return;
    if (
      e.kind === "protocol" &&
      e.payload.method !== "item/started" &&
      e.payload.method !== "item/completed" &&
      e.payload.method !== "turn/completed"
    )
      return;
    const threadId =
      e.kind === "history"
        ? e.threadId
        : e.kind === "snapshot"
          ? e.snapshot.threadId
          : e.kind === "protocol"
            ? (e.payload.params as { threadId: string }).threadId
            : null;
    const items =
      e.kind === "history"
        ? e.items
        : e.kind === "snapshot"
          ? e.snapshot.items
          : e.kind !== "protocol"
            ? []
            : e.payload.method === "item/completed" ||
                e.payload.method === "item/started"
              ? [e.payload.params.item]
              : e.payload.method === "turn/completed"
                ? e.payload.params.turn.items
                : [];
    this.store.update((s) => {
      const c = s.conversations.find(
        (c) => c.id === (envelope.conversationId ?? threadId),
      );
      if (!c) return;
      if (!envelope.simulated && c.binding?.threadId !== threadId) return;
      if (e.kind === "protocol")
        c.compactions = updateCompactions(
          c.compactions ?? [],
          e.payload,
          envelope.at,
        );
      for (const item of items) {
        if (!c.itemOrder.includes(item.id)) c.itemOrder.push(item.id);
        if (item.type !== "userMessage" && item.type !== "agentMessage") {
          const i = c.activity.findIndex((v) => v.id === item.id);
          if (i < 0) c.activity.push(item);
          else c.activity[i] = item;
          continue;
        }
        const message = {
          id: item.id,
          imageIds:
            item.type === "userMessage"
              ? (c.attachments ?? [])
                  .filter((image) =>
                    item.content.some(
                      (input) =>
                        input.type === "localImage" &&
                        input.path === this.images.path(c.id, image),
                    ),
                  )
                  .map((image) => image.id)
              : [],
          role:
            item.type === "userMessage"
              ? ("user" as const)
              : ("assistant" as const),
          text:
            item.type === "userMessage"
              ? item.content
                  .flatMap((v) => (v.type === "text" ? [v.text] : []))
                  .join("\n")
              : item.text,
          simulated: envelope.simulated,
        };
        const index = c.messages.findIndex((m) => m.id === message.id);
        const source =
          e.kind === "history"
            ? "history"
            : e.kind === "snapshot"
              ? "interrupted"
              : e.kind === "protocol" && e.payload.method === "item/completed"
                ? "completed"
                : e.kind === "protocol" && e.payload.method === "item/started"
                  ? "started"
                  : e.kind === "protocol" &&
                      e.payload.method === "turn/completed" &&
                      e.payload.params.turn.status === "completed"
                    ? "completed"
                    : "interrupted";
        const saved = mergeMessage(
          index >= 0 ? c.messages[index] : undefined,
          message,
          source,
        );
        if (index >= 0) c.messages[index] = saved;
        else c.messages.push(saved);
        if (item.type === "userMessage" && c.draft === message.text)
          c.draft = "";
        if (item.type === "userMessage")
          c.draftImageIds = (c.draftImageIds ?? []).filter(
            (id) => !message.imageIds.includes(id),
          );
        if (item.type === "userMessage" && !c.titleEdited && c.title === "New conversation")
          c.title = message.text.slice(0, 60) || "Image conversation";
      }
      if (e.kind === "protocol" && e.payload.method === "turn/completed") c.updatedAt = envelope.at;
    });
  }
  async invoke(name: string, args: unknown): Promise<Result<unknown>> {
    try {
      const validated = validateOperation(name, args);
      // Public directory I/O neither owns Core resources nor delays a Core
      // update. It must remain readable while inference or updates are busy.
      if (validated.name === "pluginDirectoryRead")
        return await this.api.pluginDirectoryRead((validated.args as [boolean])[0]);
      if (
        (this.updater.busy || this.runtimePaused) &&
        ![
          "coreUpdateStatus",
          "engineSnapshot",
          "capabilities",
          "state",
          "metrics",
          "closeReady",
        ].includes(name)
      )
        throw Error(
          "App Server update is in progress; new operations are temporarily paused",
        );
      const fn = this.api[validated.name as Operation] as (
        ...args: unknown[]
      ) => Promise<Result<unknown>>;
      this.calls++;
      try {
        return await fn(...validated.args);
      } finally {
        this.calls--;
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "INVALID_OPERATION",
          message: error instanceof Error ? error.message : "Invalid request",
        },
      };
    }
  }
  async dispose() {
    this.disposed = true;
    await this.controlMcp.dispose();
    await this.botUpdates.dispose();
    await this.pluginDirectoryUpdates.dispose();
    this.queueEpoch++;
    clearTimeout(this.queueTimer);
    this.holdQueuedMessages();
    this.notifications.dispose();
    await processResourceCleanup(
      async () => {
        const settled = await Promise.allSettled([
          this.delegations.dispose(),
          this.engine.dispose(),
        ]);
        const errors = settled
          .filter((r) => r.status === "rejected")
          .map((r) => r.reason);
        if (errors.length)
          throw new AggregateError(errors, "Engine/worker cleanup failed");
      },
      () => this.providerLogin.dispose(),
      () => this.googleLogin.dispose(),
      () => this.updater.dispose(),
      () => this.backend.dispose(),
      () => this.gpuCollector.dispose(),
      () => this.catalogIcons.dispose(),
      () => this.plugins.dispose(),
      () => this.catalog.dispose(),
      () => this.account.dispose(),
      () => this.authorization.dispose(),
      () => this.terminals.dispose(),
      () => this.host.browser.dispose(),
      () => this.store.close(),
    )();
  }
}
