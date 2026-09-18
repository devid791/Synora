import assert from "node:assert/strict";
import type { CoreChannelPayload } from "../src/engine/core-channel";
import { compareCoreVersions } from "../src/engine/qualified-core";

// Only verified signed history and fully qualified reports may reach this function.
// One platform's failure/absence must neither revoke nor authorize another.
export function mergeQualifiedReleases(previous: CoreChannelPayload | undefined,
  incoming: CoreChannelPayload["releases"]) {
  assert.ok(incoming.length > 0 && incoming.length <= 3, "At least one qualified platform is required");
  assert.equal(new Set(incoming.map(r => r.package.target)).size, incoming.length, "Duplicate platform report");
  const entries = [...(previous?.releases ?? [])];
  for (const release of incoming) {
    const old = entries.find(r => r.package.target === release.package.target && r.package.version === release.package.version);
    if (old) {
      assert.deepEqual(release.package, old.package, "Published versions are immutable");
      // Preserve the original evidence receipt too: clients reject replacement.
      continue;
    }
    const newer = entries.some(r => r.package.target === release.package.target &&
      compareCoreVersions(r.package.version, release.package.version) > 0);
    assert.ok(!newer, "A delayed qualification cannot downgrade an already published platform");
    entries.push(release);
  }
  // Bounded rolling history per platform; never evict another platform on update.
  // Installed authorizations are retained separately by clients for rollback.
  const retained = entries.filter(r => entries.filter(other => other.package.target === r.package.target &&
    compareCoreVersions(other.package.version, r.package.version) > 0).length < 16);
  return retained;
}
