import type { PluginDetail } from "../protocol/codex-0.153.4/v2/PluginDetail";
import type { PluginInstallResponse } from "../protocol/codex-0.153.4/v2/PluginInstallResponse";
export interface CorePluginTarget {
  catalogId: string;
  providerId: string;
  workspaceId: string;
  marketplaceName: string;
  marketplacePath: string | null;
  pluginId: string;
  pluginName: string;
  remotePluginId: string | null;
  configurationIdentity: string;
  discoveryOnly?: boolean;
}
export type PluginAction = "install" | "uninstall";
export interface CorePluginSnapshot {
  id: string;
  target: CorePluginTarget;
  action: "inspect" | PluginAction;
  phase:
    | "preparing"
    | "reading"
    | "changing"
    | "verifying"
    | "completed"
    | "failed"
    | "cancelled"
    | "uncertain";
  startedAt: number;
  completedAt?: number;
  busy: boolean;
  cancelled: boolean;
  mutationSent: boolean;
  cleanupFailed?: boolean;
  detail: PluginDetail | null;
  installResult: PluginInstallResponse | null;
  error?: { code: string; message: string };
}
export function pluginChangeReason(
  detail: PluginDetail,
  action: PluginAction,
): string | null {
  const p = detail.summary;
  if (action === "install") {
    if (p.availability !== "AVAILABLE" || p.installPolicy === "NOT_AVAILABLE")
      return "This plugin is unavailable under the current Core policy.";
    if (p.installed && p.enabled)
      return "This plugin is already installed and enabled.";
  } else {
    if (!p.installed) return "This plugin is not installed.";
    if (
      p.installPolicy === "INSTALLED_BY_DEFAULT" ||
      p.installPolicySource === "WORKSPACE_SETTING" ||
      p.installPolicySource === "IMPLICIT_CANONICAL_APP"
    )
      return "This installation is managed by Core or your workspace administrator.";
  }
  return null;
}
