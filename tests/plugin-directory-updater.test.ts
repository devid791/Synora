import assert from "node:assert/strict";
import test from "node:test";
import { PluginDirectoryUpdater } from "../src/main/plugin-directory-updater";
import type { PluginDirectorySnapshot } from "../src/shared/plugin-directory";

test("Directory auto-update is metadata-only, preference-aware and rate-limited", async () => {
  let now = 100_000, enabled = false, reads = 0, refreshes = 0, disposed = 0;
  const directory = {
    read: async () => { reads++; return { fetchedAt: 1 } as PluginDirectorySnapshot; },
    refresh: async () => { refreshes++; return { fetchedAt: now } as PluginDirectorySnapshot; },
    dispose: async () => { disposed++; },
  };
  const updater = new PluginDirectoryUpdater(directory, () => enabled, { now: () => now, intervalMs: 1_000 });
  await updater.tick(); assert.equal(reads, 0);
  enabled = true;
  await updater.tick(); assert.equal(refreshes, 1);
  await updater.tick(); assert.equal(refreshes, 1);
  now += 1_001; await updater.tick(); assert.equal(refreshes, 2);
  await updater.dispose(); await updater.tick(); assert.equal(refreshes, 2); assert.equal(disposed, 1);
});

test("Fresh cache skips downloads; a failed refresh cannot create a retry storm", async () => {
  let fetchedAt = 10_000, refreshes = 0;
  const updater = new PluginDirectoryUpdater({
    read: async () => ({ fetchedAt } as PluginDirectorySnapshot),
    refresh: async () => { refreshes++; throw Error("offline"); },
    dispose: async () => {},
  }, () => true, { now: () => 10_500, intervalMs: 1_000 });
  await updater.tick(); assert.equal(refreshes, 0);
  fetchedAt = 1;
  await assert.rejects(updater.tick(), /offline/);
  await updater.tick(); assert.equal(refreshes, 1);
  await updater.dispose();
});

test("Turning auto-update off while reading prevents a subsequent fetch", async () => {
  let enabled = true, refreshed = false;
  const updater = new PluginDirectoryUpdater({
    read: async () => { enabled = false; return { fetchedAt: 0 } as PluginDirectorySnapshot; },
    refresh: async () => { refreshed = true; throw Error("should not fetch"); },
    dispose: async () => {},
  }, () => enabled);
  await updater.tick(); assert.equal(refreshed, false); await updater.dispose();
});
