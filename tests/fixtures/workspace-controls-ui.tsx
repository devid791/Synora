import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceModelPicker } from "../../src/renderer/WorkspaceModelPicker";
import { ProviderDirectory } from "../../src/renderer/ProviderDirectory";
import { LiveTelemetry } from "../../src/renderer/LiveTelemetry";
import { providerPreset } from "../../src/shared/provider-onboarding";
import { emptyEngine } from "../../src/renderer/engine-state";
import type { AppState, DesktopAPI } from "../../src/shared/contracts";
const w = window as any;
w.calls = [];
w.applied = [];
const initial: any = {
  engine: { mode: "live", providerId: "axiom", model: "qwen" },
  integrations: [
    {
      ...providerPreset("axiom", []),
      id: "axiom",
      name: "Axiom",
      endpoint: "http://127.0.0.1:8015/codex/v1",
    },
  ],
};
let update: (state: any) => void;
const models = (id: string) => [
  {
    id: id === "axiom" ? "qwen" : "gpt-wire-from-core",
    reasoning_efforts: id === "axiom" ? ["ultra-fast"] : ["low", "high"],
    default_reasoning_effort: id === "axiom" ? "ultra-fast" : "low",
    context_window: null,
    context_window_options: [],
    ...(id !== "axiom"
      ? {
          coreModel: {
            isDefault: true,
            displayName: "GPT from actual catalog contract",
          },
        }
      : {}),
  },
];
const api = {
  async coreAccountRead() {
    w.calls.push("account/read");
    initial.integrations.push(providerPreset("openai", initial.integrations));
    update({ ...initial });
    return { ok: true, value: { account: { account: { type: "chatgpt" } } } };
  },
  async state() {
    return { ok: true, value: initial };
  },
  async engineModels(id: string) {
    w.calls.push(`models:${id}`);
    if (w.fail) return { ok: false, error: { message: "Catalog unavailable" } };
    return { ok: true, value: models(id) };
  },
  async backendStatus() {
    w.polls = (w.polls ?? 0) + 1;
    return { ok: true, value: { mode: "inactive", reason: "Controlled test" } };
  },
} as unknown as DesktopAPI;
function Fixture() {
  const [state, setState] = useState<AppState>(initial),
    [busy, setBusy] = useState(false),
    [engine, setEngine] = useState(emptyEngine);
  update = setState;
  w.stream = () =>
    setEngine({
      ...emptyEngine,
      status: "running",
      startedAt: Date.now(),
      firstDeltaAt: Date.now() + 100,
      items: [
        {
          type: "agentMessage",
          id: "a",
          text: "Streaming before completion",
          phase: null,
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      ],
    });
  w.busy = setBusy;
  return (
    <main>
      <WorkspaceModelPicker
        api={api}
        state={state}
        busy={busy}
        accounts={() => (w.accounts = true)}
        runOperation={async (fn) => {
          setBusy(true);
          try {
            await fn();
          } finally {
            setBusy(false);
          }
        }}
        apply={async (config) => {
          w.applied.push(config);
        }}
      />
      <ProviderDirectory
        providers={state.integrations}
        busy={busy}
        choose={(t) => {
          w.chosen = t;
        }}
      />
      <footer>
        <LiveTelemetry api={api} engine={engine} axiom={true} />
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
