import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Explicit local acceptance of our built package, not arbitrary archives or URLs.
assert.ok(
  process.argv[2] && process.argv[3],
  "Expected archive and report paths",
);
const candidate = process.env.SYNORA_TEST_CORE_UPDATE_VERSION;
assert.match(candidate ?? "", /^\d+\.\d+\.\d+$/);
const archive = resolve(process.argv[2]),
  report = resolve(process.argv[3]);
const name = basename(archive).replace(/\.tar\.gz$/, "");
assert.match(name, /^Synora-\d+\.\d+\.\d+-web-linux-x64$/);
const root = await mkdtemp(join(tmpdir(), "synora-web-package-check-"));
execFileSync("tar", ["-xzf", archive, "-C", root]);
const folder = join(root, name),
  manifest = JSON.parse(await readFile(join(folder, "release.json"), "utf8"));
for (const e of manifest.entries) {
  assert.ok(!e.path.startsWith("/") && !e.path.split("/").includes(".."));
  const b = await readFile(join(folder, e.path));
  assert.equal(b.length, e.size);
  assert.equal(createHash("sha256").update(b).digest("hex"), e.sha256);
}
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "note.txt"), "BEFORE\n");
const child = spawn(process.execPath, [join(folder, "start.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    SYNORA_WEB_PORT: "0",
    SYNORA_WEB_DATA_DIR: join(root, "profile"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "",
  stderr = "";
child.stdout.on("data", (b) => (stdout += b));
child.stderr.on("data", (b) => (stderr += b));
const fixture = createServer((_q, r) => {
  r.setHeader("Content-Type", "text/html");
  r.end(
    '<!doctype html><title>Package browser</title><input style="width:250px;height:40px" oninput="document.title=this.value">',
  );
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
const result = {
  version: manifest.version,
  status: "RUNNING",
  manifestFiles: manifest.entries.length,
  checks: [],
};
async function until(fn, limit = 30000) {
  const end = Date.now() + limit;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw Error("Timed out");
    await delay(200);
  }
}
try {
  const url = await until(
    () => stdout.match(/Synora local web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1],
  );
  const boot = await fetch(url + "/api/bootstrap", {
      headers: { Origin: url },
    }),
    { csrf } = await boot.json();
  const headers = {
    Origin: url,
    Cookie: boot.headers.get("set-cookie").split(";")[0],
    "X-Synora-CSRF": csrf,
    "Content-Type": "application/json",
  };
  const api = async (name, ...args) => {
    const r = await fetch(url + "/api/" + name, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
    const v = await r.json();
    if (!v.ok) throw Error(name + ": " + v.error.message);
    return v.value;
  };
  const initial = await api("coreUpdateStatus");
  assert.equal(initial.automatic, true);
  assert.notEqual(initial.currentVersion, candidate);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url + "/api/bootstrap")).status, 403);
  result.checks.push("relocated compiled startup", "host/session boundary");
  const w = await api("chooseWorkspace", workspace),
    doc = await api("readFile", w.id, "note.txt");
  await api("saveFile", w.id, { ...doc, content: "AFTER\n" });
  assert.equal(await readFile(join(workspace, "note.txt"), "utf8"), "AFTER\n");
  result.checks.push("real file read/write");
  const terminal = await api("terminalOpen", w.id);
  await api(
    "terminalWrite",
    terminal.id,
    "printf WEB_TERMINAL_OK > terminal-proof.txt\n",
  );
  await until(
    async () =>
      (await readFile(join(workspace, "terminal-proof.txt"), "utf8").catch(
        () => null,
      )) === "WEB_TERMINAL_OK",
  );
  await api("terminalClose", terminal.id);
  result.checks.push("real native PTY");
  const tabs = await api(
      "browserOpen",
      `http://127.0.0.1:${fixture.address().port}`,
    ),
    tab = tabs.at(-1);
  await until(async () =>
    (await api("browserList")).some((t) => t.title === "Package browser"),
  );
  await api("browserInput", tab.id, {
    type: "click",
    x: 50,
    y: 25,
    button: "left",
  });
  await api("browserInput", tab.id, { type: "text", text: "WEB_BROWSER_OK" });
  await until(async () => {
    await api("browserFrame", tab.id);
    return (await api("browserList")).some((t) => t.title === "WEB_BROWSER_OK");
  });
  await api("browserAction", tab.id, "close");
  result.checks.push("bundled sandboxed browser + real input");
  const account = await api("coreAccountRead");
  assert.equal(account.busy, false);
  assert.ok(account.observedAt);
  result.checks.push("bundled Core initialization");
  // Do not force an update/check. The packaged service's normal startup timer
  // must discover, verify, download and activate the genuine signed candidate.
  const updated = await until(async () => {
    const s = await api("coreUpdateStatus");
    if (s.phase === "failed") throw Error(s.message);
    return s.currentVersion === candidate ? s : false;
  }, 450000);
  assert.equal(updated.previousVersion, initial.currentVersion);
  assert.ok(updated.checks.some((c) => c.includes("settings and history")));
  result.checks.push("real signed Core update on web service startup");
  result.update = updated;
  result.status = "PASS";
} catch (e) {
  result.status = "FAIL";
  result.error = String(e);
  result.stderr = stderr;
  process.exitCode = 1;
} finally {
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(10000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
  fixture.close();
  await writeFile(report, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  await rm(root, { recursive: true, force: true });
}
