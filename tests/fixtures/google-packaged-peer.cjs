// QA overlay only. Load through Playwright AFTER the real packaged main starts.
// Never require a replacement main, replace fetch, or synthesize an IPC result.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = require("undici");

function createPeerDispatcher(endpoint, previous, peer, requests) {
  const target = new URL(endpoint);
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.ok(target.port);
  assert.equal(target.pathname, "/");
  assert.equal(
    target.search + target.hash + target.username + target.password,
    "",
  );
  return {
    dispatch(options, handler) {
      if (
        String(options.origin) === "https://oauth2.googleapis.com" &&
        ["/token", "/revoke"].includes(options.path) &&
        options.method === "POST" &&
        !options.query
      ) {
        // Preserve body, headers, abort/response handler and the complete HTTP
        // exchange. Only the physical peer's origin changes. No TLS/DNS edits.
        requests.push({
          origin: String(options.origin),
          path: options.path,
          method: options.method,
        });
        return peer.dispatch({ ...options, origin: target.origin }, handler);
      }
      // No wildcard Google interception and no invented successful responses.
      return previous.dispatch(options, handler);
    },
  };
}

let state;
function install({ endpoint, directory, executable, asarSha256 }) {
  assert.equal(state, undefined, "Only one peer fixture per disposable app");
  const { app, BrowserWindow, shell } = require("electron");
  assert.equal(app.isPackaged, true);
  assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable));
  assert.equal(
    fs.realpathSync(app.getPath("userData")),
    fs.realpathSync(directory),
  );
  const asar = app.getAppPath();
  assert.equal(path.basename(asar), "app.asar");
  const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  // Electron fs views an ASAR as a directory. The documented original-fs
  // module reads the archive's raw bytes without toggling process.noAsar.
  const archiveHash = crypto
    .createHash("sha256")
    .update(require("original-fs").readFileSync(asar))
    .digest("hex");
  assert.equal(archiveHash, asarSha256);
  const main = path.join(asar, "dist/main.cjs");
  assert.ok(
    require.cache[main]?.loaded,
    "Actual packaged main must already be loaded",
  );
  const window = BrowserWindow.getAllWindows()[0];
  const preferences = window.webContents.getLastWebPreferences();
  // Electron 44's SaveLastPreferences omits preload. This read-only internal
  // getter is pinned/verified against v44.3.0 source; never replaces a preload.
  const preload = window.webContents._getPreloadScript();
  assert.equal(preload.filePath, path.join(asar, "dist/preload.cjs"));
  assert.equal(preload.type, "frame");
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(process.argv.includes("--no-sandbox"), false);
  const capturedFetch = globalThis.fetch;
  const previous = getGlobalDispatcher();
  const peer = new Agent({ connections: 1, pipelining: 0 });
  const requests = [];
  const dispatcher = createPeerDispatcher(endpoint, previous, peer, requests);
  const originalOpenExternal = shell.openExternal;
  const opened = [];
  const opener = async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://accounts.google.com");
    assert.equal(parsed.pathname, "/o/oauth2/v2/auth");
    assert.equal(parsed.username + parsed.password + parsed.hash, "");
    opened.push(url);
  };
  setGlobalDispatcher(dispatcher); // documented public API; NO symbol mutation
  shell.openExternal = opener;
  assert.equal(globalThis.fetch, capturedFetch);
  state = {
    capturedFetch,
    previous,
    peer,
    dispatcher,
    requests,
    opened,
    opener,
    originalOpenExternal,
    restored: false,
    identity: {
      packaged: app.isPackaged,
      executable: process.execPath,
      pid: process.pid,
      appPath: asar,
      userData: app.getPath("userData"),
      argv: process.argv,
      node: process.versions.node,
      electron: process.versions.electron,
      builtinUndici: process.versions.undici,
      externalUndici: require("undici/package.json").version,
      asarSha256: archiveHash,
      mainSha256: hash(main),
      preload: preload.filePath,
      preloadSha256: hash(preload.filePath),
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
    },
  };
  return snapshot();
}

function snapshot() {
  assert.ok(state);
  const root = path.dirname(require.resolve("undici/package.json"));
  return {
    ...state.identity,
    scope:
      "Controlled Google HTTP peer and external browser; NOT public authorization or inference",
    fetchUnchanged: globalThis.fetch === state.capturedFetch,
    dispatcherInstalled: getGlobalDispatcher() === state.dispatcher,
    requests: [...state.requests],
    opened: [...state.opened],
    restored: state.restored,
    // Inventory the existing external QA dependency actually loaded in main.
    undiciFiles: Object.keys(require.cache)
      .filter((p) => p.startsWith(root + path.sep))
      .sort()
      .map((file) => ({
        file,
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      })),
  };
}

async function restore() {
  assert.ok(state);
  assert.equal(globalThis.fetch, state.capturedFetch);
  assert.equal(getGlobalDispatcher(), state.dispatcher);
  const { shell } = require("electron");
  assert.equal(shell.openExternal, state.opener);
  setGlobalDispatcher(state.previous);
  shell.openExternal = state.originalOpenExternal;
  await state.peer.close();
  state.restored = true;
  return snapshot();
}

module.exports = { createPeerDispatcher, install, snapshot, restore };
