import { z } from "zod";
import type { CompactionRecord } from "./compaction";
import type { ImageAttachment, ImageUpload } from "./image-attachments";
import type { CoreCatalogSnapshot } from "./core-catalog";
import type { CatalogIconRequest, CatalogIcon } from "./catalog-icon";
import type { CorePluginSnapshot, PluginAction } from "./core-plugin";
import { oauthBrowserUrl } from "./oauth-url";
import { mountedProviderTypes, providerDefinitions } from "./provider-registry";
import {
  compatibleSettingsSchema,
  type CompatibleModelOverride,
} from "./compatible-provider";
import type { BackendStatus } from "./backend-status";
import type { AccountLogin, CoreAccountStatus } from "./core-account";
import type { ProviderLoginStatus } from "./provider-login";
import type { GoogleAccountStatus, GoogleClient } from "./google-oauth";
import type { Model as CoreModel } from "../protocol/codex-0.153.4/v2/Model";
import type { ServerNotification } from "../protocol/codex-0.153.4/ServerNotification";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
import type { CommandExecutionRequestApprovalParams } from "../protocol/codex-0.153.4/v2/CommandExecutionRequestApprovalParams";
import type { FileChangeRequestApprovalParams } from "../protocol/codex-0.153.4/v2/FileChangeRequestApprovalParams";
import type { ThreadTokenUsage } from "../protocol/codex-0.153.4/v2/ThreadTokenUsage";
import type { McpServerStatus } from "../protocol/codex-0.153.4/v2/McpServerStatus";
import type { PermissionsRequestApprovalParams } from "../protocol/codex-0.153.4/v2/PermissionsRequestApprovalParams";
import type { ToolRequestUserInputParams } from "../protocol/codex-0.153.4/v2/ToolRequestUserInputParams";
export type ApprovalParams =
  | CommandExecutionRequestApprovalParams
  | FileChangeRequestApprovalParams
  | PermissionsRequestApprovalParams;
export type UserQuestion = { id: string; params: ToolRequestUserInputParams };

export const engineConfigSchema = z
  .object({
    mode: z.enum(["simulated", "live"]),
    providerId: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    reasoningEffort: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (v) => v.mode === "simulated" || (!!v.providerId && !!v.model),
    "Select a provider and model for live mode",
  );
export type EngineConfig = z.infer<typeof engineConfigSchema>;
export type NativeToolSetup = {
  platform: string;
  status: "notApplicable" | "ready" | "notConfigured" | "updateRequired";
};
export const bindingSchema = z
  .object({
    permission: z.enum(["ask", "auto-review", "full"]).optional(),
    threadId: z.string().min(1),
    sessionId: z.string().min(1),
    endpoint: z.string().url(),
    model: z.string().min(1),
    cwd: z.string().min(1),
    hostToolCatalogHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type EngineBinding = z.infer<typeof bindingSchema>;

export const PROTOCOL_VERSION = "0.153.4" as const;
export const OPENAI_ENDPOINT = providerDefinitions.openai.endpoint;
export const XAI_ENDPOINT = providerDefinitions.xai.endpoint;
export const views = [
  "workspace",
  "agents",
  "bots",
  "browser",
  "models",
  "connectors",
  "plugins",
  "telemetry",
  "settings",
] as const;
export type View = (typeof views)[number];
export const profiles = [
  "ultra-fast",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const scenarios = [
  "text",
  "tool",
  "agents",
  "approval",
  "failure",
  "slow",
  "disconnect",
] as const;
export type Scenario = (typeof scenarios)[number];
export const botSourceSchema = z.object({
  provider: z.literal("agency-agents"),
  path: z.string().max(512).regex(/^[a-z0-9-]+\/[a-zA-Z0-9_./-]+\.md$/).refine(p => !p.includes("..") && !p.includes("//")),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  blobSha: z.string().regex(/^[a-f0-9]{40}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  license: z.literal("MIT"),
  licenseText: z.string().min(1).max(32000),
  sourceUrl: z.string().url().startsWith("https://github.com/msitarzewski/agency-agents/blob/"),
  managed: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(s => s.sourceUrl === `https://github.com/msitarzewski/agency-agents/blob/${s.revision}/${s.path}`, "Source must match the pinned repository revision and path");
export interface BotCatalogUpdateStatus {
  checking: boolean;
  lastCheckedAt: number | null;
  lastSuccessAt: number | null;
  updated: number;
  error: string | null;
}
export const presetSchema = z
  .object({
    schema: z.literal("synora.bot.v1"),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    instructions: z.string().max(16000),
    kind: z.enum([
      "coding",
      "research",
      "scheduled",
      "event",
      "browser",
      "supervisor",
    ]),
    profile: z.enum(profiles),
    context: z.union([z.literal(262144), z.literal(1048576)]),
    connectorIds: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(64),
    enabled: z.boolean(),
    source: botSourceSchema.optional(),
  })
  .strict();
export type Preset = z.infer<typeof presetSchema> & { id: string };
export const sessionDefaultsSchema = z.object({
  permission: z.enum(["ask", "auto-review", "full"]),
  bot: presetSchema.extend({ id: z.string().min(1) }).nullable(),
}).strict();
export const configSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .max(80),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["provider", "connector", "mcp"]),
    providerType: z.enum(mountedProviderTypes).optional(),
    compatible: compatibleSettingsSchema.optional(),
    executor: z.enum(["configuration-only", "searxng", "http-mcp"]).optional(),
    endpoint: z.string().max(2048),
    enabled: z.boolean(),
    auth: z.enum(["none", "api-key", "oauth", "core-account"]),
    tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(256),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.providerType === "compatible") !== (v.compatible !== undefined))
      ctx.addIssue({
        code: "custom",
        path: ["compatible"],
        message:
          "An explicit Responses capability configuration is required only for the compatible endpoint adapter",
      });
    if (
      v.providerType === "compatible" &&
      (!["none", "api-key"].includes(v.auth) ||
        v.tools.length ||
        (v.executor && v.executor !== "configuration-only"))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Compatible endpoints require anonymous or API-key authentication and Core's actual tools",
      });
    if (
      v.providerType === "gemini" &&
      v.auth === "oauth" &&
      v.endpoint.replace(/\/$/, "") !== providerDefinitions.gemini.endpoint
    )
      ctx.addIssue({
        code: "custom",
        message: "Google OAuth requires the official Gemini HTTPS endpoint",
      });
    if (
      (v.providerType === "xai" ||
        v.providerType === "mistral" ||
        v.providerType === "deepseek" ||
        v.providerType === "openrouter" ||
        v.providerType === "anthropic" ||
        v.providerType === "gemini") &&
      ((v.auth !== "api-key" &&
        !(v.providerType === "gemini" && v.auth === "oauth")) ||
        v.tools.length ||
        (v.executor && v.executor !== "configuration-only"))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "This provider requires its supported authentication and Core's actual tools, not declared executor names",
      });
    if (v.providerType && v.kind !== "provider")
      ctx.addIssue({
        code: "custom",
        message: "Only providers can select an inference adapter",
      });
    if (v.providerType === "openai") {
      if (
        v.auth !== "core-account" ||
        v.endpoint !== OPENAI_ENDPOINT ||
        (v.executor && v.executor !== "configuration-only") ||
        v.tools.length
      )
        ctx.addIssue({
          code: "custom",
          message:
            "OpenAI uses the isolated Core account and original OpenAI routes, with no custom endpoint or declared tools",
        });
    } else if (v.auth === "core-account")
      ctx.addIssue({
        code: "custom",
        message: "Core account authentication requires the OpenAI provider",
      });
    if (v.executor && v.executor !== "configuration-only") {
      if (
        (v.executor === "searxng" && v.kind !== "connector") ||
        (v.executor === "http-mcp" && v.kind !== "mcp")
      )
        ctx.addIssue({
          code: "custom",
          message: "The executor does not match the integration kind",
        });
      if (!v.endpoint)
        ctx.addIssue({
          code: "custom",
          message: "An executable integration requires an endpoint",
        });
      if (
        v.auth !== "none" &&
        !(v.executor === "http-mcp" && v.auth === "oauth")
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Account authentication is not mounted for this executor yet",
        });
    }
    if (!v.endpoint) return;
    try {
      if (v.executor === "http-mcp" && v.auth === "oauth")
        oauthBrowserUrl(v.endpoint);
      const u = new URL(v.endpoint);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.search ||
        u.hash
      )
        throw new Error();
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Use an HTTP(S) endpoint without credentials, query string or fragment.",
      });
    }
  });
export type Integration = z.infer<typeof configSchema>;
export type ProviderCredentialStatus = {
  providerId: string;
  present: boolean;
  usable: boolean;
  storage: "os-encrypted" | "private-file";
};
/** Ephemeral login evidence, not a claim that a server's tools are connected. */
export type McpAuthorization = {
  id: string;
  pluginId?: string;
  busy?: boolean;
  cleanupFailed?: boolean;
  integrationId: string;
  providerId: string;
  serverName: string;
  status:
    | "starting"
    | "awaiting_browser"
    | "authorized"
    | "failed"
    | "cancelled";
  authorizationUrl?: string;
  code?: string;
  message?: string;
  expiresAt: number;
};
export type Availability = "configured" | "disabled" | "not-connected";
export interface Workspace {
  id: string;
  name: string;
  path: string;
}
export interface Conversation {
  titleEdited?: boolean;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  updatedAt?: number;
  projectId?: string | null;
  forkedFrom?: string;
  /** Immutable creation-time defaults; never a reference to a mutable preset. */
  defaults?: z.infer<typeof sessionDefaultsSchema>;
  queuedMessages?: import("./user-preferences").QueuedMessage[];
  usage?: import("./session-usage").SessionUsage;
  orchestration?: import("./orchestration").OrchestrationPlan;
  compactions?: CompactionRecord[];
  attachments?: ImageAttachment[];
  draftImageIds?: string[];
  backendRequests?: AxiomRequestMetrics[];
  itemOrder: string[];
  activity: ThreadItem[];
  binding?: EngineBinding;
  id: string;
  title: string;
  workspaceId: string | null;
  draft: string;
  messages: Array<{
    imageIds?: string[];
    id: string;
    role: "user" | "assistant";
    text: string;
    incomplete?: boolean;
    simulated: boolean;
  }>;
  createdAt: number;
}
export interface AgentRecord {
  coreSessionId?: string;
  model?: string | null;
  profile?: string | null;
  closed?: boolean;
  metadataError?: string | null;
  turnId?: string | null;
  startedAt?: number;
  completedAt?: number;
  activity?: ThreadItem[];
  backendRequests?: AxiomRequestMetrics[];
  id: string;
  name: string;
  parentId: string;
  task: string;
  status:
    | "pendingInit"
    | "running"
    | "completed"
    | "interrupted"
    | "errored"
    | "shutdown"
    | "notFound";
  result: string;
  simulated: boolean;
}
export type Status =
  | "idle"
  | "running"
  | "waiting"
  | "disconnected"
  | "completed"
  | "failed"
  | "interrupted";
export interface ModelCapabilities {
  input_modalities?: string[];
  id: string;
  context_window: number | null;
  context_window_options: number[];
  reasoning_efforts: string[];
  default_reasoning_effort?: string;
  coreModel?: CoreModel;
  unavailableReason?: string;
  providerModel?: {
    provider:
      | "xai"
      | "openrouter"
      | "anthropic"
      | "gemini"
      | "deepseek"
      | "mistral"
      | "compatible";
    aliases: string[];
    inputModalities: string[];
    description: string;
    compatible?: CompatibleModelOverride;
    mistral?: { functionCalling: boolean };
    gemini?: { maxOutput: number; thinking: boolean; maxTemperature?: number };
    anthropic?: {
      maxOutput: number;
      adaptiveThinking: boolean;
      structuredOutputs: boolean;
    };
  };
}
export interface AxiomRequestMetrics {
  source: "axiom-response";
  responseId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  model: string;
  profile: string;
  observedAt: number;
  thinkingTokens: number;
  visibleTokens: number;
  thinkingBudget: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  prefillSeconds: number;
  decodeSeconds: number;
  ttftSeconds: number;
  decodeTokensPerSecond: number;
  visibleTokensPerSecond: number;
  decodePath: string;
  speculativeMode: string;
  prefixHitTokens: number;
  suffixPrefillTokens: number;
}
export interface EngineSnapshot {
  usage?: import("./session-usage").SessionUsage;
  appServer?: {
    phase: "starting" | "ready" | "reconnecting" | "offline";
    attempts: number;
    pid?: number;
    checkedAt?: number;
    retryAt?: number;
    message?: string;
  };
  compactions?: CompactionRecord[];
  cleanupPending?: boolean;
  backendRequests?: AxiomRequestMetrics[];
  modelCatalog?: ModelCapabilities[];
  selection?: {
    model: string;
    profile: string;
    context: number | null;
    contextRequestField: "context_window" | "core-managed";
  };
  questions?: UserQuestion[];
  mcpServers?: McpServerStatus[];
  connection: "simulated" | "live" | "disconnected";
  conversationId?: string;
  sessionId?: string;
  error?: { code: string; message: string } | null;
  tokenUsage?: ThreadTokenUsage;
  firstDeltaAt?: number;
  startedAt?: number;
  completedAt?: number;
  threadId: string | null;
  turnId: string | null;
  status: Status;
  items: ThreadItem[];
  agents: AgentRecord[];
  approval: {
    id: string;
    params: ApprovalParams;
  } | null;
  sequence: number;
}
export type EngineEvent =
  | { kind: "backend-metrics"; metrics: AxiomRequestMetrics }
  | { kind: "history"; items: ThreadItem[]; threadId: string }
  | { kind: "snapshot"; snapshot: EngineSnapshot }
  | { kind: "protocol"; payload: ServerNotification }
  | {
      kind: "approval";
      id: string;
      params: ApprovalParams;
    }
  | {
      kind: "connection";
      state: "simulated" | "live" | "disconnected";
      appServer?: EngineSnapshot["appServer"];
    }
  | { kind: "agents"; agents: AgentRecord[] };
export interface EventEnvelope {
  sequence: number;
  at: number;
  simulated: boolean;
  conversationId?: string;
  event: EngineEvent;
}
export interface AppState {
  delegations: import("../engine/delegation-coordinator").DelegationTask[];
  engine: EngineConfig;
  version: 1;
  workspaces: Workspace[];
  conversations: Conversation[];
  presets: Preset[];
  integrations: Integration[];
  agentHistory: AgentRecord[];
  preferences: {
    conversationGrouping?: "project" | "list";
    selectedConversationId?: string | null;
    conversationSort?: import("./conversation-management").ConversationSort;
    botCatalogAutomatic?: boolean;
    pluginCatalogAutomatic?: boolean;
    defaultBotId?: string | null;
    theme?: "system" | "light" | "dark";
    busyEnterBehavior?: "queue" | "steer";
    launchAtLogin?: boolean;
    systemNotifications?: boolean;
    locale?: import("./locale").Locale;
    localMemory?: import("./local-memory").LocalMemoryProfile;
    permission?: import("./permission-mode").PermissionMode;
    mode: "default" | "plan";
    view: View;
    profile: (typeof profiles)[number];
    context: 262144 | 1048576;
    compact: boolean;
    sidebarCollapsed?: boolean;
    filesCollapsed?: boolean;
  };
  revision: number;
}
export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
export interface FileDocument {
  path: string;
  content: string;
  revision: string;
}
export interface TerminalInfo {
  id: string;
  workspaceId: string;
  pid: number;
  status: "running" | "exited";
  exitCode: number | null;
  output: string;
  sequence: number;
}
export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  error: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}
export interface BrowserFrame {
  dataURL: string;
  width: number;
  height: number;
}
export type BrowserInput =
  | { type: "click"; x: number; y: number; button: "left" | "right" | "middle" }
  | { type: "key"; key: string }
  | { type: "text"; text: string }
  | { type: "scroll"; x: number; y: number; deltaX: number; deltaY: number };
export interface LocalMetrics {
  hostMemory?: import("./local-resource-metrics").HostMemorySample;
  localMemory?: import("./local-memory").LocalMemoryStatus;
  rssBytes: number;
  uptimeSeconds: number;
  terminalCount: number;
  browserCount: number;
  gpu: null;
  tokens: null;
  observedAt: number;
}
export type DesktopEvent =
  | {
      kind: "delegations";
      tasks: import("../engine/delegation-coordinator").DelegationTask[];
      revision: number;
    }
  | { kind: "resync" }
  | { kind: "prepare-close"; id: string }
  | { kind: "engine"; data: EventEnvelope }
  | {
      kind: "terminal";
      id: string;
      data: string;
      sequence: number;
      exitCode?: number;
    }
  | { kind: "browser"; tabs: BrowserTab[] }
  | { kind: "notice"; message: string };
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };
export interface PlatformCapabilities {
  launchAtLogin?: import("./user-preferences").PreferenceCapability;
  systemNotifications?: import("./user-preferences").PreferenceCapability;
  platform: "linux" | "win32" | "darwin" | "web";
  transport: "desktop-ipc" | "local-http";
  nativeDialogs: boolean;
  terminal: boolean;
  embeddedBrowser: boolean;
  browserPresentation?: "native-view" | "remote-frame";
  engine: "simulated" | "live";
  liveInference: boolean;
}
export interface DesktopAPI {
  orchestrationConfigure(
    conversationId: string,
    plan: import("./orchestration").OrchestrationPlan | null,
  ): Promise<Result<AppState>>;
  delegationCancel(
    conversationId: string,
    taskId: string,
  ): Promise<Result<AppState>>;
  delegationApprove(
    conversationId: string,
    taskId: string,
    approvalId: string,
    approved: boolean,
  ): Promise<Result<void>>;
  delegationAnswer(
    conversationId: string,
    taskId: string,
    questionId: string,
    answers: Record<string, string[]>,
  ): Promise<Result<void>>;
  coreUpdateStatus(): Promise<Result<import("./core-update").CoreUpdateStatus>>;
  coreUpdateCheck(): Promise<Result<import("./core-update").CoreUpdateStatus>>;
  coreUpdateAutomatic(
    enabled: boolean,
  ): Promise<Result<import("./core-update").CoreUpdateStatus>>;
  coreUpdateInstall(
    version: string,
  ): Promise<Result<import("./core-update").CoreUpdateStatus>>;
  coreUpdateRollback(
    recoveryId: string,
    confirmed: true,
  ): Promise<Result<import("./core-update").CoreUpdateStatus>>;
  coreCatalogStatus(): Promise<Result<CoreCatalogSnapshot | null>>;
  coreCatalogIcon(request: CatalogIconRequest): Promise<Result<CatalogIcon>>;
  corePluginStatus(): Promise<Result<CorePluginSnapshot | null>>;
  corePluginInspect(
    catalogId: string,
    marketplace: string,
    pluginId: string,
  ): Promise<Result<CorePluginSnapshot>>;
  corePluginChange(
    reviewId: string,
    action: PluginAction,
    confirmed: true,
  ): Promise<Result<CorePluginSnapshot>>;
  corePluginCancel(id: string): Promise<Result<CorePluginSnapshot | null>>;
  corePluginAuthorize(
    reviewId: string,
    serverName: string,
  ): Promise<Result<McpAuthorization>>;
  coreCatalogRead(
    providerId: string,
    workspaceId: string,
    remote: boolean,
  ): Promise<Result<CoreCatalogSnapshot>>;
  coreCatalogCancel(id: string): Promise<Result<CoreCatalogSnapshot | null>>;
  coreAccountStatus(): Promise<Result<CoreAccountStatus>>;
  coreAccountRead(): Promise<Result<CoreAccountStatus>>;
  coreAccountLogin(login: AccountLogin): Promise<Result<CoreAccountStatus>>;
  coreAccountCancel(id: string): Promise<Result<CoreAccountStatus>>;
  coreAccountOpen(id: string): Promise<Result<void>>;
  coreAccountLogout(): Promise<Result<CoreAccountStatus>>;
  providerCredentialStatus(
    providerId: string,
  ): Promise<Result<ProviderCredentialStatus>>;
  providerLoginStatus(): Promise<Result<ProviderLoginStatus | null>>;
  googleAccountStatus(providerId: string): Promise<Result<GoogleAccountStatus>>;
  googleAccountForget(
    providerId: string,
    confirmed: true,
  ): Promise<Result<GoogleAccountStatus>>;
  googleAccountConfigure(
    providerId: string,
    client: GoogleClient,
  ): Promise<Result<GoogleAccountStatus>>;
  googleAccountDisconnect(
    providerId: string,
    revoke: boolean,
  ): Promise<Result<GoogleAccountStatus>>;
  googleLoginStatus(): Promise<Result<ProviderLoginStatus | null>>;
  googleLoginStart(providerId: string): Promise<Result<ProviderLoginStatus>>;
  googleLoginCancel(id: string): Promise<Result<ProviderLoginStatus>>;
  googleLoginOpen(id: string): Promise<Result<void>>;
  providerLoginStart(
    providerId: string,
    method: "browser" | "paste-code",
  ): Promise<Result<ProviderLoginStatus>>;
  providerLoginSubmit(
    id: string,
    code: string,
  ): Promise<Result<ProviderLoginStatus>>;
  providerLoginCancel(id: string): Promise<Result<ProviderLoginStatus>>;
  providerLoginOpen(id: string): Promise<Result<void>>;
  providerCredentialSave(
    providerId: string,
    token: string,
  ): Promise<Result<ProviderCredentialStatus>>;
  providerCredentialDelete(
    providerId: string,
  ): Promise<Result<ProviderCredentialStatus>>;
  mcpAuthorize(
    integrationId: string,
    providerId: string,
  ): Promise<Result<McpAuthorization>>;
  mcpAuthorizationStatus(): Promise<Result<McpAuthorization | null>>;
  mcpAuthorizationOpen(id: string): Promise<Result<void>>;
  mcpAuthorizationCancel(id: string): Promise<Result<McpAuthorization>>;
  backendStatus(): Promise<Result<BackendStatus>>;
  engineNativeSetup(
    providerId: string,
    workspaceId: string,
    mode?: "elevated" | "unelevated",
  ): Promise<Result<NativeToolSetup>>;
  engineAnswer(
    id: string,
    answers: Record<string, string[]>,
  ): Promise<Result<EngineSnapshot>>;
  engineRestore(conversationId: string): Promise<Result<EngineSnapshot>>;
  engineCompact(conversationId: string): Promise<Result<EngineSnapshot>>;
  engineConfigure(config: EngineConfig): Promise<Result<EngineSnapshot>>;
  engineModels(providerId: string): Promise<Result<ModelCapabilities[]>>;
  closeReady(id: string, unsavedFile: boolean): Promise<Result<void>>;
  capabilities(): Promise<Result<PlatformCapabilities>>;
  state(): Promise<Result<AppState>>;
  clipboardWriteText(text: string): Promise<Result<void>>;
  preferences(
    patch: Partial<AppState["preferences"]>,
  ): Promise<Result<AppState>>;
  chooseWorkspace(path?: string): Promise<Result<Workspace | null>>;
  conversationWorkspace(
    id: string,
    workspaceId: string | null,
  ): Promise<Result<AppState>>;
  listFiles(workspaceId: string, path: string): Promise<Result<FileEntry[]>>;
  readFile(workspaceId: string, path: string): Promise<Result<FileDocument>>;
  saveFile(
    workspaceId: string,
    document: FileDocument,
  ): Promise<Result<FileDocument>>;
  newConversation(workspaceId: string | null, presetId?: string | null): Promise<Result<Conversation>>;
  conversationUpdate(id: string, patch: import("./conversation-management").ConversationPatch): Promise<Result<AppState>>;
  conversationPermission(id: string | null, permission: import("./permission-mode").PermissionMode): Promise<Result<AppState>>;
  conversationDelete(id: string, confirmed: true): Promise<Result<{ state: AppState; cleanupWarning?: string }>>;
  conversationForkDraft(id: string, confirmed: true): Promise<Result<Conversation>>;
  saveDraft(id: string, text: string): Promise<Result<void>>;
  discardQueuedMessage(
    conversationId: string,
    messageId: string,
  ): Promise<Result<AppState>>;
  imageAttach(
    conversationId: string,
    image: ImageUpload,
  ): Promise<Result<AppState>>;
  imageRead(
    conversationId: string,
    imageId: string,
  ): Promise<Result<{ dataUrl: string }>>;
  imageRemove(
    conversationId: string,
    imageId: string,
  ): Promise<Result<AppState>>;
  presetSave(value: unknown, id?: string): Promise<Result<AppState>>;
  presetInstallTemplate(templateId: string): Promise<Result<{ state: AppState; presetId: string }>>;
  botCatalogRead(refresh: boolean): Promise<Result<import("./agency-catalog").AgencyCatalogSnapshot | null>>;
  botCatalogPreview(entryId: string, revision: string): Promise<Result<import("./agency-catalog").AgencyPreview>>;
  botCatalogImport(previewId: string, confirmed: true): Promise<Result<{ state: AppState; presetId: string }>>;
  botCatalogUpdates(): Promise<Result<BotCatalogUpdateStatus>>;
  pluginDirectoryRead(refresh: boolean): Promise<Result<import("./plugin-directory").PluginDirectorySnapshot>>;
  presetDelete(id: string): Promise<Result<AppState>>;
  presetImport(): Promise<Result<AppState | null>>;
  presetExport(id: string): Promise<Result<boolean>>;
  integrationSave(
    value: unknown,
    originalId?: string,
  ): Promise<Result<AppState>>;
  integrationDelete(id: string): Promise<Result<AppState>>;
  engineStart(
    conversationId: string,
    text: string,
    scenario: Scenario,
    busy?: import("./user-preferences").BusySubmission,
  ): Promise<Result<EngineSnapshot>>;
  engineCancel(): Promise<Result<EngineSnapshot>>;
  engineApprove(id: string, approved: boolean): Promise<Result<EngineSnapshot>>;
  engineSnapshot(): Promise<Result<EngineSnapshot>>;
  engineReconnect(
    after: number,
  ): Promise<Result<{ snapshot: EngineSnapshot; events: EventEnvelope[] }>>;
  terminalOpen(workspaceId: string): Promise<Result<TerminalInfo>>;
  terminalList(): Promise<Result<TerminalInfo[]>>;
  terminalWrite(id: string, input: string): Promise<Result<void>>;
  terminalResize(id: string, cols: number, rows: number): Promise<Result<void>>;
  terminalClose(id: string): Promise<Result<void>>;
  browserOpen(url: string): Promise<Result<BrowserTab[]>>;
  browserNavigate(id: string, url: string): Promise<Result<void>>;
  browserAction(
    id: string,
    action: "back" | "forward" | "reload" | "close",
  ): Promise<Result<BrowserTab[]>>;
  browserLayout(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number },
  ): Promise<Result<void>>;
  browserList(): Promise<Result<BrowserTab[]>>;
  browserFrame(id: string): Promise<Result<BrowserFrame>>;
  browserInput(id: string, input: BrowserInput): Promise<Result<void>>;
  metrics(): Promise<Result<LocalMetrics>>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}
declare global {
  interface Window {
    synora: DesktopAPI;
  }
}
