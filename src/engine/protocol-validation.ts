import Ajv from "ajv";
import experimentalThreadSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadStartParams.experimental.json" with { type: "json" };
import compactSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadCompactStartResponse.json" with { type: "json" };
import terminalsSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadBackgroundTerminalsListResponse.json" with { type: "json" };
import terminateSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadBackgroundTerminalsTerminateResponse.json" with { type: "json" };
import type { ThreadBackgroundTerminalsListResponse } from "../protocol/codex-0.153.4/v2/ThreadBackgroundTerminalsListResponse";
import type { ThreadBackgroundTerminalsTerminateResponse } from "../protocol/codex-0.153.4/v2/ThreadBackgroundTerminalsTerminateResponse";
import initializeSchema from "../../docs/protocol/codex-0.153.4/v1/InitializeResponse.json" with { type: "json" };
import type { InitializeResponse } from "../protocol/codex-0.153.4/InitializeResponse";
import pluginsSchema from "../../docs/protocol/codex-0.153.4/v2/PluginListResponse.json" with { type: "json" };
import appsSchema from "../../docs/protocol/codex-0.153.4/v2/AppsListResponse.json" with { type: "json" };
import installedAppsSchema from "../../docs/protocol/codex-0.153.4/v2/AppsInstalledResponse.json" with { type: "json" };
import pluginDetailSchema from "../../docs/protocol/codex-0.153.4/v2/PluginReadResponse.json" with { type: "json" };
import pluginInstallSchema from "../../docs/protocol/codex-0.153.4/v2/PluginInstallResponse.json" with { type: "json" };
import pluginUninstallSchema from "../../docs/protocol/codex-0.153.4/v2/PluginUninstallResponse.json" with { type: "json" };
import type { PluginReadResponse } from "../protocol/codex-0.153.4/v2/PluginReadResponse";
import type { PluginInstallResponse } from "../protocol/codex-0.153.4/v2/PluginInstallResponse";
import type { PluginUninstallResponse } from "../protocol/codex-0.153.4/v2/PluginUninstallResponse";
import type { PluginListResponse } from "../protocol/codex-0.153.4/v2/PluginListResponse";
import type { AppsListResponse } from "../protocol/codex-0.153.4/v2/AppsListResponse";
import type { AppsInstalledResponse } from "../protocol/codex-0.153.4/v2/AppsInstalledResponse";
import addFormats from "ajv-formats";
import notificationSchema from "../../docs/protocol/codex-0.153.4/ServerNotification.json" with { type: "json" };
import requestSchema from "../../docs/protocol/codex-0.153.4/ServerRequest.json" with { type: "json" };
import startSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadStartResponse.json" with { type: "json" };
import readSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadReadResponse.json" with { type: "json" };
import type { ThreadReadResponse } from "../protocol/codex-0.153.4/v2/ThreadReadResponse";
import resumeSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadResumeResponse.json" with { type: "json" };
import turnSchema from "../../docs/protocol/codex-0.153.4/v2/TurnStartResponse.json" with { type: "json" };
import itemsSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadItemsListResponse.json" with { type: "json" };
import turnsSchema from "../../docs/protocol/codex-0.153.4/v2/ThreadTurnsListResponse.json" with { type: "json" };
import mcpSchema from "../../docs/protocol/codex-0.153.4/v2/ListMcpServerStatusResponse.json" with { type: "json" };
import windowsReadinessSchema from "../../docs/protocol/codex-0.153.4/v2/WindowsSandboxReadinessResponse.json" with { type: "json" };
import windowsSetupSchema from "../../docs/protocol/codex-0.153.4/v2/WindowsSandboxSetupStartResponse.json" with { type: "json" };
import oauthSchema from "../../docs/protocol/codex-0.153.4/v2/McpServerOauthLoginResponse.json" with { type: "json" };
import accountSchema from "../../docs/protocol/codex-0.153.4/v2/GetAccountResponse.json" with { type: "json" };
import modelListSchema from "../../docs/protocol/codex-0.153.4/v2/ModelListResponse.json" with { type: "json" };
import type { ModelListResponse } from "../protocol/codex-0.153.4/v2/ModelListResponse";
import accountLoginSchema from "../../docs/protocol/codex-0.153.4/v2/LoginAccountResponse.json" with { type: "json" };
import accountCancelSchema from "../../docs/protocol/codex-0.153.4/v2/CancelLoginAccountResponse.json" with { type: "json" };
import accountLogoutSchema from "../../docs/protocol/codex-0.153.4/v2/LogoutAccountResponse.json" with { type: "json" };
import type { GetAccountResponse } from "../protocol/codex-0.153.4/v2/GetAccountResponse";
import type { LoginAccountResponse } from "../protocol/codex-0.153.4/v2/LoginAccountResponse";
import type { CancelLoginAccountResponse } from "../protocol/codex-0.153.4/v2/CancelLoginAccountResponse";
import type { LogoutAccountResponse } from "../protocol/codex-0.153.4/v2/LogoutAccountResponse";
import type { McpServerOauthLoginResponse } from "../protocol/codex-0.153.4/v2/McpServerOauthLoginResponse";
import experimentalTurnSchema from "../../docs/protocol/codex-0.153.4/v2/TurnStartParams.experimental.json" with { type: "json" };
import type { ListMcpServerStatusResponse } from "../protocol/codex-0.153.4/v2/ListMcpServerStatusResponse";
import type { ThreadStartResponse } from "../protocol/codex-0.153.4/v2/ThreadStartResponse";
import type { ThreadResumeResponse } from "../protocol/codex-0.153.4/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "../protocol/codex-0.153.4/v2/TurnStartResponse";
import type { ThreadItemsListResponse } from "../protocol/codex-0.153.4/v2/ThreadItemsListResponse";
import type { ThreadTurnsListResponse } from "../protocol/codex-0.153.4/v2/ThreadTurnsListResponse";
import type { ServerNotification } from "../protocol/codex-0.153.4/ServerNotification";
import type { ServerRequest } from "../protocol/codex-0.153.4/ServerRequest";

const ajv = new Ajv({
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allErrors: false,
});
addFormats(ajv);
ajv.addFormat("double", { type: "number", validate: Number.isFinite });
for (const [name, min, max] of [
  ["uint", 0, Number.MAX_SAFE_INTEGER],
  ["uint16", 0, 65535],
  ["uint32", 0, 4294967295],
  ["uint64", 0, Number.MAX_SAFE_INTEGER],
  ["int32", -2147483648, 2147483647],
  ["int64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const)
  ajv.addFormat(name, {
    type: "number",
    validate: (v) => Number.isSafeInteger(v) && v >= min && v <= max,
  });
const notification = ajv.compile(notificationSchema),
  request = ajv.compile(requestSchema);
const turnStart = ajv.compile(experimentalTurnSchema);
const threadStart = ajv.compile(experimentalThreadSchema);
export function validateThreadStart(value: unknown) {
  if (!threadStart(value))
    throw Error(
      `Invalid App Server thread/start parameters: ${ajv.errorsText(threadStart.errors)}`,
    );
}
export function validateTurnStart(value: unknown) {
  if (!turnStart(value))
    throw new Error(
      `Invalid App Server turn/start parameters: ${ajv.errorsText(turnStart.errors)}`,
    );
}
export const validThreadItem = ajv.compile({
  $ref: "#/definitions/ThreadItem",
  definitions: itemsSchema.definitions,
});
const responseValidators = {
  compact: ajv.compile(compactSchema),
  terminals: ajv.compile(terminalsSchema),
  terminate: ajv.compile(terminateSchema),
  initialize: ajv.compile(initializeSchema),
  pluginDetail: ajv.compile(pluginDetailSchema),
  pluginInstall: ajv.compile(pluginInstallSchema),
  pluginUninstall: ajv.compile(pluginUninstallSchema),
  plugins: ajv.compile(pluginsSchema),
  apps: ajv.compile(appsSchema),
  installedApps: ajv.compile(installedAppsSchema),
  modelList: ajv.compile(modelListSchema),
  account: ajv.compile(accountSchema),
  accountLogin: ajv.compile(accountLoginSchema),
  accountCancel: ajv.compile(accountCancelSchema),
  accountLogout: ajv.compile(accountLogoutSchema),
  oauth: ajv.compile(oauthSchema),
  read: ajv.compile(readSchema),
  windowsReadiness: ajv.compile(windowsReadinessSchema),
  windowsSetup: ajv.compile(windowsSetupSchema),
  mcp: ajv.compile(mcpSchema),
  start: ajv.compile(startSchema),
  resume: ajv.compile(resumeSchema),
  turn: ajv.compile(turnSchema),
  items: ajv.compile(itemsSchema),
  turns: ajv.compile(turnsSchema),
};
type Responses = {
  compact: Record<string, never>;
  terminals: ThreadBackgroundTerminalsListResponse;
  terminate: ThreadBackgroundTerminalsTerminateResponse;
  initialize: InitializeResponse;
  pluginDetail: PluginReadResponse;
  pluginInstall: PluginInstallResponse;
  pluginUninstall: PluginUninstallResponse;
  plugins: PluginListResponse;
  apps: AppsListResponse;
  installedApps: AppsInstalledResponse;
  modelList: ModelListResponse;
  account: GetAccountResponse;
  accountLogin: LoginAccountResponse;
  accountCancel: CancelLoginAccountResponse;
  accountLogout: LogoutAccountResponse;
  oauth: McpServerOauthLoginResponse;
  read: ThreadReadResponse;
  windowsReadiness: { status: "ready" | "notConfigured" | "updateRequired" };
  windowsSetup: { started: boolean };
  mcp: ListMcpServerStatusResponse;
  start: ThreadStartResponse;
  resume: ThreadResumeResponse;
  turn: TurnStartResponse;
  items: ThreadItemsListResponse;
  turns: ThreadTurnsListResponse;
};
export function parseResponse<K extends keyof Responses>(
  kind: K,
  value: unknown,
): Responses[K] {
  const check = responseValidators[kind];
  if (!check(value))
    throw new Error(
      `Invalid App Server ${kind} response: ${ajv.errorsText(check.errors).slice(0, 500)}`,
    );
  return value as Responses[K];
}
export function parseNotification(value: unknown): ServerNotification {
  if (!notification(value))
    throw new Error(
      `Invalid App Server notification: ${ajv.errorsText(notification.errors).slice(0, 500)}`,
    );
  return value as ServerNotification;
}
export function parseServerRequest(value: unknown): ServerRequest {
  if (!request(value))
    throw new Error(
      `Invalid App Server request: ${ajv.errorsText(request.errors).slice(0, 500)}`,
    );
  return value as ServerRequest;
}
