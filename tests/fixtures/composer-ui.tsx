// Controlled UI fixture only. Not native/model/production evidence.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ContextUsage } from "../../src/renderer/ContextUsage";
import { ComposerAdd } from "../../src/renderer/ComposerAdd";
import { PermissionPicker } from "../../src/renderer/PermissionPicker";
import {
  AppServerConnection,
  AppServerStatus,
} from "../../src/renderer/AppServerConnection";
import { setLocale } from "../../src/renderer/i18n";
import { captureUsage, emptyUsage } from "../../src/shared/session-usage";
import { emptyEngine } from "../../src/renderer/engine-state";
import type { PermissionMode } from "../../src/shared/permission-mode";
const w = window as any;
w.locale = setLocale;
const last = {
  ...emptyUsage(),
  totalTokens: 178000,
  inputTokens: 177000,
  outputTokens: 1000,
};
const usage = captureUsage(
  "owned",
  "turn",
  { total: { ...last, totalTokens: 356000 }, last, modelContextWindow: 258000 },
  1000,
);
function Fixture() {
  const [permission, setPermission] = useState<PermissionMode>("ask");
  const [busy, setBusy] = useState(false);
  const [core, setCore] = useState({
    ...emptyEngine,
    connection: "live" as const,
    appServer: { phase: "ready" as const, attempts: 0, pid: 9397 },
  });
  w.core = setCore;
  w.busy = setBusy;
  return (
    <main style={{ padding: 16, paddingTop: 240 }}>
      <h1>CONTROLLED UI FIXTURE</h1>
      <code>Workspace bash {"{tool_id:1}"}</code>
      <AppServerConnection
        engine={core}
        busy={busy}
        reconnect={() => {
          w.reconnects = (w.reconnects ?? 0) + 1;
        }}
      />
      <form className="composer" onSubmit={(e) => e.preventDefault()}>
        <textarea aria-label="Fixture message" defaultValue="KEEP_MY_DRAFT" />
        <div className="composer-controls">
          <ComposerAdd
            busy={false}
            plugins={() => (w.plugins = true)}
            models={() => (w.models = true)}
          >
            <button type="button" onClick={() => (w.attachment = true)}>
              Attach fixture image
            </button>
          </ComposerAdd>
          <PermissionPicker
            mode={permission}
            busy={busy}
            change={async (p) => {
              w.calls = (w.calls ?? 0) + 1;
              if (w.failPermission)
                throw Error("CONTROLLED permission failure");
              if (w.deferPermission)
                await new Promise<void>((resolve) => {
                  w.finishPermission = resolve;
                });
              w.permission = p;
              setPermission(p);
            }}
          />
          <ContextUsage
            engine={{
              ...emptyEngine,
              status: "completed",
              usage,
              turnId: "turn",
              threadId: "owned",
            }}
          />
          <button type="submit" className="send" aria-label="Send fixture">
            ↑
          </button>
        </div>
      </form>
      <footer>
        <AppServerStatus engine={core} />
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
