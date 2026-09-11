import { isDeepStrictEqual } from "node:util";
import type { PluginListResponse } from "../protocol/codex-0.153.4/v2/PluginListResponse";
import type { CoreCatalogSnapshot } from "../shared/core-catalog";

/** Compare complete original objects (including unknown fields), never names,
 * selected policy fields or first/last-wins. A conflicting group stays blocked
 * even when a later occurrence matches the first one. */
export class CatalogIdentityIndex<T> {
  private groups = new Map<string, { item: T; scope: unknown; occurrences: number; conflict: boolean }>();
  add(key: string, item: T, scope: unknown = null) {
    const group = this.groups.get(key);
    if (!group) this.groups.set(key, { item, scope, occurrences: 1, conflict: false });
    else {
      group.occurrences++;
      if (!isDeepStrictEqual(group.item, item) || !isDeepStrictEqual(group.scope, scope)) group.conflict = true;
    }
  }
  result() {
    const entries: { key: string; item: T }[] = [], conflicts: { key: string; occurrences: number }[] = [];
    let identicalDuplicates = 0;
    for (const [key, group] of this.groups) {
      if (group.conflict) conflicts.push({ key, occurrences: group.occurrences });
      else { entries.push({ key, item: group.item }); identicalDuplicates += group.occurrences - 1; }
    }
    return { entries, values: entries.map(e => e.item), conflicts, identicalDuplicates };
  }
}
export function normalizePluginIdentities(input: PluginListResponse) {
  type Marketplace = PluginListResponse["marketplaces"][number];
  const index = new CatalogIdentityIndex<Marketplace["plugins"][number]>();
  const owner = new Map<string, number>();
  input.marketplaces.forEach(({ plugins, ...scope }, mi) => {
    for (const plugin of plugins) {
      const key = JSON.stringify([scope.name, plugin.id]);
      if (!owner.has(key)) owner.set(key, mi);
      index.add(key, plugin, scope);
    }
  });
  const result = index.result();
  const plugins = structuredClone(input);
  for (const marketplace of plugins.marketplaces) marketplace.plugins = [];
  // Retain exact marketplace scope, plugin wire IDs, order and capability metadata.
  for (const { key, item } of result.entries) {
    plugins.marketplaces[owner.get(key)!].plugins.push(structuredClone(item));
  }
  const conflicts: NonNullable<CoreCatalogSnapshot["identityConflicts"]> = result.conflicts.map(({ key, occurrences }) => {
    const [marketplace, id] = JSON.parse(key) as [string, string];
    return { kind: "plugin", marketplace, id, occurrences };
  });
  return { plugins, conflicts, identicalDuplicates: result.identicalDuplicates };
}
