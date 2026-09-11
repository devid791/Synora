// One read-only graphical follow-up to the completed -02 task, NOT a P13 rerun.
// Only existing typed state/snapshot reads; startup performs normal Core resume.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { _electron, expect, type ElectronApplication } from "@playwright/test";
import type { AppState, EngineSnapshot } from "../../src/shared/contracts";
import { frozen, executable, dataRoot, core, protectedIdentity, inspectSession,
  readPreparedState, hashFile } from "./supervisor-windows-admission";

const id = "supervisor-windows-c7a7-20260909-p13-02-history-03";
const output = join(frozen.root, "out/live-evidence", id);
const original = join(frozen.root, "out/live-evidence/supervisor-windows-c7a7-20260909-p13-02");
const originalHashes = {
  "evidence.json": "89536b44f0960d062c7c6bb16832feadf4df2b76ac8e8a74f88b8b2ba7144a1b",
  "supervisor-windows-150.png": "0caa7956ba6b3f21b56889d013a79e51dbb02147ba4600d84f3a4eeb1232f6e1",
  "test.json": "ebad75f84fbdb72552027b85dc6b11310a6197d1ca58bef37c290dee152dfab5",
};
const conversationId = "ff5da5dc-7e7c-4b45-b8ef-3ccdd41f21cf";
const taskId = "8bc81334-7109-40cf-a974-e9ff6bfce56d";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// Stable evidence hash only; no object below is supplied to the app or DB.
const stateHash = (value: AppState) => sha(JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const unchanged = (before: AppState, after: AppState) => {
  assert.ok(Number.isSafeInteger(after.revision) && after.revision >= before.revision);
  assert.deepEqual({ ...after, revision: before.revision }, before,
    "History, drafts, task/review, binding, metrics and all saved selections must remain exact");
  return { beforeRevision: before.revision, afterRevision: after.revision,
    beforeSha256: stateHash(before), afterSha256: stateHash(after),
    substantiveDifferences: [], permittedDifference: "monotonic state.revision only" };
};

assert.equal(process.platform, "win32");
assert.equal(win32.resolve(process.cwd()).toLowerCase(), frozen.root.toLowerCase());
for (const key of ["SYNORA_AUTHORIZE_WINDOWS_SETUP", "SYNORA_CODEX_BINARY",
  "SYNORA_QA_CORE_LAUNCHER", "SYNORA_QA_RESET_AFTER_SUCCESS", "NODE_OPTIONS",
  "ELECTRON_RUN_AS_NODE", "SYNORA_ONE_AGENT_AUTHORIZED", "SYNORA_P13_WINDOWS_GPU_HANDOFF"])
  assert.ok(!process.env[key], `No inference/setup/runtime override: ${key}`);
await mkdir(output); // Exclusive new evidence directory; never overwrite/retry.
const receipt: Record<string, unknown> = { id, started: new Date().toISOString(),
  scope: "Read-only same-completed-history graphical follow-up; NOT a new P13 pass",
  frozen, originalHashes, conversationId, taskId, passed: false,
  fixtureTurnStarts: 0, fixtureDelegations: 0, fixtureReviewRequests: 0 };
const calls: string[] = [], errors: string[] = [], cleanupErrors: string[] = [];
let app: ElectronApplication | undefined, before: AppState | undefined;
const capture = async (file: string) => {
  const pixels = Buffer.from(await app!.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64")), "base64");
  await writeFile(join(output, file), pixels, { flag: "wx" });
  return { file, bytes: pixels.length, sha256: sha(pixels) };
};
try {
  for (const [file, hash] of Object.entries(originalHashes))
    assert.equal(await hashFile(join(original, file)), hash);
  receipt.overlay = await Promise.all([
    "supervisor-windows-history.ts", "supervisor-windows-history-run.ps1",
    "supervisor-windows-admission.ts", "supervisor-windows-session.ps1",
  ].map(async file => ({ file, sha256: await hashFile(join("tests/fixtures", file)) })));
  receipt.sessionBefore = await inspectSession();
  receipt.identityBefore = await protectedIdentity();
  const proof = JSON.parse(await readFile(join(original, "evidence.json"), "utf8")) as {
    passed: boolean; afterCloseState: AppState; final: EngineSnapshot;
  };
  assert.equal(proof.passed, true);
  before = readPreparedState();
  receipt.originalComparison = unchanged(proof.afterCloseState, before);
  assert.equal(before.conversations[0].id, conversationId, "Resume only the already selected -02 conversation");
  assert.equal(before.preferences.view, "agents", "Do not change saved view/selection");
  const task = before.delegations.find(t => t.id === taskId)!;
  assert.equal(task?.parentConversationId, conversationId);
  assert.equal(task.status, "completed");
  assert.equal(task.review?.verdict, "accepted");
  assert.ok(!before.delegations.some(t => ["queued", "running"].includes(t.status)));
  receipt.savedTaskSha256 = sha(JSON.stringify(task));
  receipt.binding = before.conversations[0].binding;
  app = await _electron.launch({ executablePath: executable, args: ["--disable-gpu"],
    chromiumSandbox: true, cwd: frozen.root, env: { ...process.env, SYNORA_DATA_DIR: dataRoot } });
  const main = await app.evaluate(({ app, BrowserWindow }) => {
    const load = process.getBuiltinModule("module").createRequire(app.getAppPath() + "/package.json");
    const path = load("node:path");
    const wc = BrowserWindow.getAllWindows()[0].webContents as any;
    return { pid: process.pid, ppid: process.ppid, packaged: app.isPackaged,
      executable: process.execPath, dataRoot: app.getPath("userData"), appPath: app.getAppPath(),
      mainLoaded: load.cache[path.join(app.getAppPath(), "dist/main.cjs")]?.loaded,
      preload: wc._getPreloadScript().filePath, sandbox: wc.getLastWebPreferences().sandbox,
      contextIsolation: wc.getLastWebPreferences().contextIsolation,
      nodeIntegration: wc.getLastWebPreferences().nodeIntegration,
      noSandbox: process.argv.includes("--no-sandbox") };
  });
  receipt.main = main; receipt.launcherPid = app.process().pid;
  assert.equal(main.ppid, app.process().pid);
  assert.equal(main.packaged, true); assert.equal(main.mainLoaded, true);
  assert.equal(main.executable.toLowerCase(), executable.toLowerCase());
  assert.equal(main.dataRoot.toLowerCase(), dataRoot.toLowerCase());
  assert.equal(main.preload, win32.join(main.appPath, "dist/preload.cjs"));
  assert.equal(main.sandbox, true); assert.equal(main.contextIsolation, true);
  assert.equal(main.nodeIntegration, false); assert.equal(main.noSandbox, false);
  receipt.sessionLaunched = await inspectSession(main.pid);
  const page = await app.firstWindow();
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(20000);
  await expect(page.getByRole("button", { name: "Workspace", exact: true })).toBeVisible();
  const state = async () => {
    calls.push("state");
    const r = await page.evaluate(() => window.synora.state());
    if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`);
    return r.value;
  };
  let snapshot: EngineSnapshot | undefined;
  const recoveryObservations: unknown[] = [];
  receipt.recoveryObservations = recoveryObservations;
  const deadline = Date.now() + 75000;
  while (true) {
    calls.push("engineSnapshot");
    const r = await page.evaluate(() => window.synora.engineSnapshot());
    if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`);
    snapshot = r.value;
    recoveryObservations.push({ at: new Date().toISOString(), connection: snapshot.connection,
      status: snapshot.status, conversationId: snapshot.conversationId, threadId: snapshot.threadId,
      sessionId: snapshot.sessionId, turnId: snapshot.turnId, itemIds: snapshot.items.map(i => i.id),
      backendResponseIds: snapshot.backendRequests?.map(r => r.responseId), error: snapshot.error });
    assert.equal(snapshot.error, null); assert.equal(snapshot.approval, null);
    // LiveEngine.restore explicitly publishes running while loading history.
    // That transient label is not evidence of turn/start. Reject actual new
    // identities/items/responses immediately; require exact completed history.
    for (const key of ["conversationId", "threadId", "sessionId", "turnId"] as const)
      assert.ok(snapshot[key] == null || snapshot[key] === proof.final[key], `Unexpected restored ${key}`);
    assert.ok(snapshot.items.every(i => proof.final.items.some(old => old.id === i.id)), "Unexpected new history item");
    assert.ok((snapshot.backendRequests ?? []).every(r => proof.final.backendRequests?.some(old => isDeepStrictEqual(old, r))),
      "Unexpected new or changed backend response during history restore");
    if (snapshot.connection === "live" && snapshot.conversationId === conversationId && snapshot.status === "completed") break;
    assert.ok(Date.now() < deadline, "Timed out waiting for the original completed history; no retry");
    await page.waitForTimeout(250);
  }
  assert.ok(snapshot);
  for (const key of ["threadId", "sessionId", "turnId"] as const)
    assert.equal(snapshot[key], proof.final[key]);
  assert.deepEqual(snapshot.backendRequests, proof.final.backendRequests);
  assert.ok(snapshot.backendRequests);
  assert.deepEqual(snapshot.items.map(i => i.id), proof.final.items.map(i => i.id));
  receipt.restored = { threadId: snapshot.threadId, sessionId: snapshot.sessionId,
    turnId: snapshot.turnId, status: snapshot.status, itemIds: snapshot.items.map(i => i.id),
    backendResponseIds: snapshot.backendRequests.map(r => r.responseId) };
  receipt.recoveryComparison = unchanged(before, await state());
  const observed = await inspectSession(main.pid);
  assert.ok(observed.children.some(p => p.ExecutablePath?.toLowerCase() === core.toLowerCase()));
  receipt.sessionRestored = observed;
  const card = page.getByRole("article", { name: `Delegated task ${task.name}`, exact: true })
    .filter({ has: page.getByText(taskId, { exact: true }) });
  await expect(card).toHaveCount(1);
  const review = card.getByRole("region", { name: "Supervisor review", exact: true });
  await expect(review.getByLabel("Review summary", { exact: true })).toHaveText(task.review!.summary);
  await expect(card.locator(":scope > pre").filter({ hasText: task.result })).toHaveText(task.result);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  // Native scrolling only: no style/text replacement, preference setter or request.
  await review.evaluate(el => el.scrollIntoView({ block: "center", inline: "nearest" }));
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  await page.waitForTimeout(150);
  receipt.layout = await review.evaluate(el => {
    // No nested named functions: tsx keepNames inserts Node-side __name helpers
    // that do not exist when Playwright serializes this callback to Chromium.
    const pane = el.closest(".orchestration-scroll")!;
    const accepted = el.querySelector("strong")!;
    const summary = el.querySelector("pre")!;
    const result = el.previousElementSibling!;
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const clips: unknown[] = [];
    for (let p = accepted.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p), r = p.getBoundingClientRect();
      const x = /auto|scroll|hidden|clip/.test(style.overflowX), y = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (x || y) {
        const c = { left: r.left + p.clientLeft, top: r.top + p.clientTop,
          right: r.left + p.clientLeft + p.clientWidth, bottom: r.top + p.clientTop + p.clientHeight };
        clips.push({ tag: p.tagName, className: p.className, ...c });
        if (x) { clip.left = Math.max(clip.left, c.left); clip.right = Math.min(clip.right, c.right); }
        if (y) { clip.top = Math.max(clip.top, c.top); clip.bottom = Math.min(clip.bottom, c.bottom); }
      }
    }
    const [a, s, r, paneRect, reviewRect] = [accepted, summary, result, pane, el].map(e => {
      const box = e.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    });
    const hit = document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2);
    return { viewport: { width: innerWidth, height: innerHeight }, pane: paneRect, clips, clip,
      accepted: a, summary: s, result: r, review: reviewRect, scrollTop: pane.scrollTop,
      acceptedContained: a.left >= clip.left && a.right <= clip.right && a.top >= clip.top && a.bottom <= clip.bottom,
      acceptedHit: hit === accepted || accepted.contains(hit),
      summaryVisibleHeight: Math.max(0, Math.min(s.bottom, clip.bottom) - Math.max(s.top, clip.top)),
      resultVisibleHeight: Math.max(0, Math.min(r.bottom, clip.bottom) - Math.max(r.top, clip.top)),
      rootHorizontalOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  const layout = receipt.layout as { acceptedContained: boolean; acceptedHit: boolean;
    summaryVisibleHeight: number; resultVisibleHeight: number; rootHorizontalOverflow: boolean };
  assert.equal(layout.acceptedContained, true); assert.equal(layout.acceptedHit, true);
  assert.ok(layout.summaryVisibleHeight > 20, "Existing review summary must intersect the actual pane/viewport");
  assert.ok(layout.resultVisibleHeight > 20, "Existing worker result must intersect the actual pane/viewport");
  assert.equal(layout.rootHorizontalOverflow, false);
  receipt.zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  assert.equal(receipt.zoom, 1.5);
  receipt.png = await capture("supervisor-windows-accepted-150.png");
  receipt.captureComparison = unchanged(before, await state());
  assert.deepEqual(errors, []);
  receipt.passed = true;
} catch (error) {
  receipt.failure = String(error);
  if (app) try { receipt.failurePng = await capture("failure-original.png"); }
  catch (e) { cleanupErrors.push(`Failure capture: ${e}`); }
} finally {
  try { await app?.close(); } catch (e) { cleanupErrors.push(`App close: ${e}`); }
  try {
    receipt.sessionAfter = await inspectSession();
    receipt.identityAfter = await protectedIdentity();
    assert.deepEqual(receipt.identityAfter, receipt.identityBefore);
    if (before) receipt.afterCloseComparison = unchanged(before, readPreparedState());
    for (const [file, hash] of Object.entries(originalHashes))
      assert.equal(await hashFile(join(original, file)), hash);
  } catch (e) { cleanupErrors.push(`Final identity/history/owners: ${e}`); }
  receipt.calls = calls; receipt.errors = errors; receipt.cleanupErrors = cleanupErrors;
  receipt.finished = new Date().toISOString();
  receipt.passed = receipt.passed === true && !cleanupErrors.length && !errors.length;
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ id, passed: receipt.passed, failure: receipt.failure, cleanupErrors }));
  if (!receipt.passed) process.exitCode = 1;
}
