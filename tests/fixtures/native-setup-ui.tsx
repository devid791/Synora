// UI-only protocol fixture. No Core process, OS setup, accounts or inference.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { EngineSettings } from "../../src/renderer/EngineSettings";
import type {
  AppState,
  DesktopAPI,
  EngineConfig,
} from "../../src/shared/contracts";
const fixture = window as unknown as {
  fixtureCalls: unknown[];
  servicePlatform?: string;
};
fixture.fixtureCalls = [];
function TestSettings() {
  const [engine, setEngine] = useState<EngineConfig>({
    mode: "simulated",
    providerId: null,
    model: null,
  });
  const state = {
    engine,
    integrations: [
      {
        id: "fixture-provider",
        name: "Fixture provider",
        kind: "provider",
        enabled: true,
      },
    ],
    workspaces: [{ id: "fixture-workspace", name: "Fixture workspace" }],
  } as AppState;
  const api = {
    engineModels: async () => ({
      ok: true,
      value: [
        {
          id: "fixture-model",
          context_window_options: [262144],
          reasoning_efforts: ["ultra-fast"],
        },
      ],
    }),
    engineConfigure: async (config: EngineConfig) => {
      setEngine(config);
      return { ok: true, value: { sequence: 1, status: "idle" } };
    },
    engineNativeSetup: async (
      providerId: string,
      workspaceId: string,
      mode?: string,
    ) => {
      fixture.fixtureCalls.push({
        providerId,
        workspaceId,
        mode: mode ?? null,
      });
      await new Promise((resolve) => setTimeout(resolve, mode ? 500 : 150));
      return mode === "elevated"
        ? {
            ok: false,
            error: {
              code: "FIXTURE",
              message: "Administrator setup declined; nothing configured",
            },
          }
        : {
            ok: true,
            value: {
              platform: "win32",
              status: mode ? "ready" : "notConfigured",
            },
          };
    },
  } as unknown as DesktopAPI;
  return (
    <EngineSettings
      api={api}
      servicePlatform={fixture.servicePlatform}
      state={state}
      busy={false}
      applied={async () => {}}
    />
  );
}
createRoot(document.getElementById("root")!).render(<TestSettings />);
