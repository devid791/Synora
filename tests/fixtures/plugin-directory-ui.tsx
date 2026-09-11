import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PluginDirectory } from "../../src/renderer/PluginDirectory";
import type { AppState, DesktopAPI } from "../../src/shared/contracts";
import seed from "../../src/shared/plugin-directory-seed.json" with { type: "json" };
import { setLocale } from "../../src/renderer/i18n";
const w = window as any;
w.directoryCalls = [];
const initial = {
  preferences: { pluginCatalogAutomatic: true },
  engine: { mode: "axiom", providerId: "axiom", model: "test-model" },
  integrations: w.noProviders ? [] : [{ id: "axiom", kind: "provider", enabled: true, name: "Axiom" }],
  workspaces: [],
} as unknown as AppState;
if (w.testLocale) setLocale(w.testLocale);
const api = new Proxy({}, { get: (_target, method) => async (...args: unknown[]) => {
  w.directoryCalls.push({ method, args });
  if (method === "pluginDirectoryRead") {
    if (w.directoryFailure) return { ok: false, error: { message: "Controlled offline failure" } };
    return { ok: true, value: { ...seed, checking: false, error: null } };
  }
  if (method === "preferences") return { ok: true, value: { ...initial, preferences: { ...initial.preferences, ...(args[0] as object) } } };
  if (["coreCatalogStatus", "corePluginStatus", "mcpAuthorizationStatus"].includes(String(method)))
    return { ok: true, value: null };
  throw Error(`Unexpected operation: ${String(method)}`);
} }) as DesktopAPI;
function App() {
  const [state, setState] = useState(initial);
  return <PluginDirectory api={api} state={state} busy={w.engineBusy ?? false} onState={setState} />;
}
createRoot(document.getElementById("root")!).render(<App />);
