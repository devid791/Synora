import type { PluginListResponse } from "../protocol/codex-0.153.4/v2/PluginListResponse";
import type { AppsListResponse } from "../protocol/codex-0.153.4/v2/AppsListResponse";
import type { AppsInstalledResponse } from "../protocol/codex-0.153.4/v2/AppsInstalledResponse";
import type { GetAccountResponse } from "../protocol/codex-0.153.4/v2/GetAccountResponse";

export interface CoreCatalogSnapshot {
  id: string;
  providerId: string;
  workspaceId: string;
  remote: boolean;
  scope: "provider-configuration";
  startedAt: number;
  completedAt?: number;
  busy: boolean;
  cancelled: boolean;
  cleanupFailed?: boolean;
  accountMode?: NonNullable<GetAccountResponse["account"]>["type"] | null;
  plugins: PluginListResponse | null;
  /** Original public entries absent from the account's installable catalog. */
  discoveryOnlyPluginIds?: string[];
  apps: AppsListResponse | null;
  installedApps: AppsInstalledResponse | null;
  /** Conflicting original identities are visible but never used as action targets.
   * Unrelated validated entries remain usable; this is an explicitly partial catalog. */
  identityConflicts?: { kind: "plugin" | "app"; id: string; marketplace?: string; occurrences: number }[];
  identicalDuplicates?: { plugins: number; apps: number };
  errors: { method: string; code: string; message: string }[];
}

/** Keep the executable account catalog authoritative; supplement, never replace,
 * it with the public curated metadata. Aliases in the two official curated
 * marketplaces are displayed once, using the account-eligible wire identity. */
export function supplementPublicCatalog(
  current: PluginListResponse,
  publicCatalog: PluginListResponse,
  // Retain precedence even for original account identities now quarantined.
  accountIdentities: PluginListResponse = current,
) {
  const result = structuredClone(current);
  const { ids, curatedNames } = publicCatalogPrecedence(accountIdentities);
  const discoveryOnlyPluginIds: string[] = [];
  for (const marketplace of publicCatalog.marketplaces) {
    if (marketplace.name !== "openai-curated") continue;
    const plugins = marketplace.plugins.filter((p) => {
      if (ids.has(p.id) || curatedNames.has(p.name)) return false;
      ids.add(p.id);
      curatedNames.add(p.name);
      discoveryOnlyPluginIds.push(p.id);
      return true;
    });
    if (!plugins.length) continue;
    const existing = result.marketplaces.find(
      (m) => m.name === marketplace.name,
    );
    if (existing) existing.plugins.push(...structuredClone(plugins));
    else
      result.marketplaces.push({
        ...structuredClone(marketplace),
        plugins: structuredClone(plugins),
      });
  }
  return { plugins: result, discoveryOnlyPluginIds };
}

/** Only the two already-qualified official marketplaces share name aliases.
 * Other marketplaces are never shadowed globally by a display name. */
export function publicCatalogPrecedence(account: PluginListResponse) {
  return {
    ids: new Set(account.marketplaces.flatMap(m => m.plugins.map(p => p.id))),
    curatedNames: new Set(account.marketplaces
      .filter(m => ["openai-api-curated", "openai-curated"].includes(m.name))
      .flatMap(m => m.plugins.map(p => p.name))),
  };
}
