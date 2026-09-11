import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Store, manifestHash } from "../src/main/store";
import {
  botTemplates,
  templatePreset,
  templatePresetId,
} from "../src/shared/bot-library";
import { operationSchemas } from "../src/shared/operations";
import type {
  AgencyCatalogSnapshot,
  AgencyPreview,
} from "../src/shared/agency-catalog";
import { BotCatalogUpdater } from "../src/main/bot-catalog-updater";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "synora-bot-library-")),
    file = join(dir, "state.sqlite");
  const store = new Store(file);
  return {
    store,
    file,
    close() {
      store.close();
      rmSync(dir, { recursive: true });
    },
  };
}
function preview(version = "1"): AgencyPreview {
  return {
    id: `preview-${version}`,
    entry: {
      id: "engineering/engineer.md",
      path: "engineering/engineer.md",
      name: "Engineer",
      category: "engineering",
      blobSha: version.repeat(40),
      bytes: 100,
    },
    revision: version.repeat(40),
    instructions: `REVIEWED_INSTRUCTIONS_${version}`,
    original: `# Engineer\nREVIEWED_INSTRUCTIONS_${version}`,
    sourceUrl: `https://github.com/msitarzewski/agency-agents/blob/${version.repeat(40)}/engineering/engineer.md`,
    sha256: createHash("sha256").update(version).digest("hex"),
    licenseText:
      "MIT License\nCopyright Agency Agents\nPermission is hereby granted...",
    warnings: [],
  } as AgencyPreview;
}

test("all eight original templates install once, select explicitly and retain immutable session defaults", () => {
  const f = fixture();
  try {
    assert.equal(botTemplates.length, 8);
    assert.equal(f.store.read().preferences.botCatalogAutomatic, true);
    const before = f.store.read();
    let lastSelected: string | null = null;
    for (const template of botTemplates) {
      const { presetId } = f.store.installTemplate(template.id);
      assert.equal(presetId, templatePresetId(template.id));
      const conversation = f.store.conversation(null, presetId);
      lastSelected = conversation.id;
      assert.equal(
        conversation.defaults!.bot!.instructions,
        template.instructions,
      );
      assert.equal(conversation.defaults!.permission, "ask");
      f.store.installTemplate(template.id);
    }
    assert.equal(f.store.read().presets.length, 8);
    assert.deepEqual(f.store.read().engine, before.engine);
    assert.deepEqual(f.store.read().preferences, { ...before.preferences, selectedConversationId: lastSelected });
    const p = f.store.read().presets[0];
    const old = f.store
      .read()
      .conversations.find((c) => c.defaults?.bot?.id === p.id)!.defaults;
    const { id, ...value } = p;
    f.store.preset({ ...value, instructions: "Custom instructions" }, id);
    f.store.installTemplate(botTemplates[0].id);
    assert.equal(
      f.store.read().presets.find((p) => p.id === id)!.instructions,
      "Custom instructions",
    );
    assert.deepEqual(
      f.store.read().conversations.find((c) => c.defaults?.bot?.id === id)!
        .defaults,
      old,
    );
    f.store.preferences({ defaultBotId: id });
    assert.equal(f.store.conversation(null).defaults!.bot!.id, id);
    assert.equal(f.store.conversation(null, null).defaults!.bot, null);
    assert.throws(() => f.store.installTemplate("fake-template"));
    assert.throws(() => f.store.conversation(null, "unavailable"));
  } finally {
    f.close();
  }
});
test("template installation preserves name collisions and IPC validates exact reviewed operations", () => {
  const f = fixture();
  try {
    f.store.preset(templatePreset("coding"));
    const installed = f.store.installTemplate("coding");
    assert.equal(
      installed.state.presets.find((p) => p.id === installed.presetId)!.name,
      "Software Developer (2)",
    );
    assert.equal(
      operationSchemas.botCatalogImport.safeParse(["preview", false]).success,
      false,
    );
    assert.equal(
      operationSchemas.botCatalogImport.safeParse(["preview", true]).success,
      true,
    );
    assert.equal(
      operationSchemas.botCatalogPreview.safeParse(["file", "main"]).success,
      false,
    );
    assert.equal(
      operationSchemas.newConversation.safeParse([null]).success,
      true,
    );
    assert.equal(
      operationSchemas.newConversation.safeParse([null, null]).success,
      true,
    );
  } finally {
    f.close();
  }
});
test("managed import retains attribution, updates only unmodified manifest and never touches running sessions", () => {
  const f = fixture();
  try {
    const { presetId } = f.store.importAgency(preview());
    const p = f.store.read().presets[0];
    assert.equal(p.source!.managed, true);
    assert.equal(p.source!.baseHash, manifestHash(p));
    assert.equal(p.source!.licenseText, preview().licenseText);
    f.store.preferences({ defaultBotId: presetId, permission: "full" });
    const conversation = f.store.conversation(null),
      originalDefaults = structuredClone(conversation.defaults);
    const before = f.store.read();
    assert.equal(
      f.store.updateAgency(presetId, p.source!.baseHash, preview("2")),
      true,
    );
    const updated = f.store.read().presets[0];
    assert.equal(updated.instructions, preview("2").instructions);
    assert.equal(updated.source!.revision, "2".repeat(40));
    assert.equal(updated.source!.baseHash, manifestHash(updated));
    assert.deepEqual(f.store.read().preferences, before.preferences);
    assert.deepEqual(f.store.read().engine, before.engine);
    assert.deepEqual(
      f.store.read().conversations[0].defaults,
      originalDefaults,
    );
    assert.equal(
      f.store.conversation(null).defaults!.bot!.instructions,
      preview("2").instructions,
    );
    assert.equal(f.store.importAgency(preview("3")).state.presets.length, 1);
    const { id, ...value } = updated;
    f.store.preset({ ...value, instructions: "my customization" }, id);
    assert.equal(f.store.read().presets[0].source!.managed, false);
    assert.equal(
      f.store.updateAgency(id, updated.source!.baseHash, preview("3")),
      false,
    );
    assert.equal(f.store.read().presets[0].instructions, "my customization");
    f.store.preset({ ...value, name: "Imported JSON attempts managed true" });
    assert.equal(f.store.read().presets.at(-1)!.source!.managed, false);
  } finally {
    f.close();
  }
});
test("managed updates validate atomically and respect toggled opt-out", () => {
  const f = fixture();
  try {
    const { presetId } = f.store.importAgency(preview()),
      p = f.store.read().presets[0];
    const before = f.store.read();
    assert.throws(() =>
      f.store.updateAgency(presetId, p.source!.baseHash, {
        ...preview("2"),
        instructions: "x".repeat(16001),
      }),
    );
    assert.deepEqual(f.store.read(), before);
    f.store.preferences({ botCatalogAutomatic: false });
    assert.equal(
      f.store.updateAgency(presetId, p.source!.baseHash, preview("2")),
      false,
    );
  } finally {
    f.close();
  }
});

function source(initial = preview()) {
  let candidate = initial;
  let failure = false,
    slow: Promise<void> | undefined;
  const calls = { refresh: 0, previews: 0, consumed: 0, disposed: 0 };
  const snapshot = (): AgencyCatalogSnapshot =>
    ({
      source: "agency-agents",
      revision: candidate.revision,
      fetchedAt: 1000,
      license: "MIT",
      entries: [candidate.entry],
    }) as AgencyCatalogSnapshot;
  const catalog = {
    async read(refresh: boolean) {
      if (refresh) {
        calls.refresh++;
        await slow;
        if (failure) throw Error("offline");
      }
      return snapshot();
    },
    async preview() {
      calls.previews++;
      return candidate;
    },
    consumePreview() {
      calls.consumed++;
      return candidate;
    },
    dispose() {
      calls.disposed++;
    },
  };
  return {
    calls,
    catalog,
    next(p: AgencyPreview) {
      candidate = p;
    },
    fail(value: boolean) {
      failure = value;
    },
    slow(p?: Promise<void>) {
      slow = p;
    },
  };
}
test("startup timer really refreshes and stops after disposal without starting any model", async () => {
  const f = fixture(), s = source();
  const updater = new BotCatalogUpdater(s.catalog, f.store, () => {}, { startupMs: 5, intervalMs: 20 });
  try {
    f.store.importAgency(preview());
    s.next(preview("2"));
    updater.start();
    const deadline = Date.now() + 2000;
    while (!updater.status().lastSuccessAt && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(updater.status().lastSuccessAt);
    assert.equal(f.store.read().presets[0].instructions, preview("2").instructions);
    await updater.dispose();
    const count = s.calls.refresh;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(s.calls.refresh, count);
    assert.equal(f.store.read().conversations.length, 0);
  } finally { await updater.dispose(); f.close(); }
});
test("automatic updater fetches only changed managed bots, coalesces checks and retains good data offline", async () => {
  const f = fixture(),
    s = source(),
    updates: number[] = [];
  const updater = new BotCatalogUpdater(s.catalog, f.store, () =>
    updates.push(1),
  );
  try {
    f.store.importAgency(preview());
    await updater.refresh();
    assert.equal(s.calls.previews, 0);
    s.next(preview("2"));
    await Promise.all([updater.refresh(), updater.refresh()]);
    assert.equal(s.calls.refresh, 2); // first + coalesced second
    assert.equal(s.calls.previews, 1);
    assert.equal(s.calls.consumed, 1);
    assert.equal(updater.status().updated, 1);
    assert.equal(
      f.store.read().presets[0].instructions,
      preview("2").instructions,
    );
    const before = f.store.read();
    s.fail(true);
    await assert.rejects(updater.refresh(), /offline/);
    assert.match(
      updater.status().error!,
      /Previously saved bots remain available/,
    );
    assert.deepEqual(f.store.read(), before);
    assert.equal(updater.status().checking, false);
    assert.ok(updates.length >= 6);
  } finally {
    await updater.dispose();
    f.close();
  }
});
test("automatic timer uses cached index, off stops polling, cancellation and mid-fetch edits prevent apply", async () => {
  const f = fixture(),
    s = source();
  const updater = new BotCatalogUpdater(s.catalog, f.store, () => {}, {
    now: () => 1001,
  });
  try {
    f.store.importAgency(preview());
    await updater.tick();
    assert.equal(s.calls.refresh, 0);
    f.store.preferences({ botCatalogAutomatic: false });
    s.next(preview("2"));
    await updater.refresh(); // manual refresh while off can list only
    assert.equal(s.calls.previews, 0);
    assert.equal(
      f.store.read().presets[0].instructions,
      preview().instructions,
    );
    f.store.preferences({ botCatalogAutomatic: true });
    let release!: () => void;
    s.slow(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const pending = updater.refresh();
    const { id, ...value } = f.store.read().presets[0];
    f.store.preset({ ...value, name: "User-owned fork" }, id);
    release();
    await pending;
    assert.equal(s.calls.previews, 0);
    assert.equal(
      f.store.read().presets[0].instructions,
      preview().instructions,
    );
  } finally {
    await updater.dispose();
    assert.equal(s.calls.disposed, 1);
    f.close();
  }
});
