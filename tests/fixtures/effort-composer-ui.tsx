// Offline full-App fixture. No service, Core, provider or host API is started.
import { createRoot } from "react-dom/client";
import { App } from "../../src/renderer/App";
import type {
  AppState,
  DesktopAPI,
  EngineSnapshot,
  Result,
} from "../../src/shared/contracts";

export interface EffortComposerFixture {
  state: AppState;
  snapshot: EngineSnapshot;
  configureCalls: Parameters<DesktopAPI["engineConfigure"]>[];
  unexpectedCalls: string[];
}

declare global {
  interface Window {
    effortComposerFixture: EffortComposerFixture;
  }
}

const fixture = window.effortComposerFixture;
const ok = <T,>(value: T): Result<T> => ({
  ok: true,
  value: structuredClone(value),
});
const implemented = {
  state: async () => ok(fixture.state),
  capabilities: async () =>
    ok({
      platform: "web" as const,
      transport: "local-http" as const,
      nativeDialogs: false,
      terminal: false,
      embeddedBrowser: false,
      engine: "simulated" as const,
      liveInference: false,
    }),
  engineSnapshot: async () => ok(fixture.snapshot),
  onEvent: () => () => {},
  browserList: async () => ok([]),
  browserLayout: async () => ok(undefined),
  metrics: async () =>
    ok({
      rssBytes: 0,
      uptimeSeconds: 0,
      terminalCount: 0,
      browserCount: 0,
      gpu: null,
      tokens: null,
      observedAt: 0,
    }),
  engineConfigure: async (...args) => {
    fixture.configureCalls.push(structuredClone(args));
    // Record the boundary verbatim; do not implement service normalization here.
    fixture.state = {
      ...fixture.state,
      engine: structuredClone(args[0]),
      revision: fixture.state.revision + 1,
    };
    fixture.snapshot = {
      ...fixture.snapshot,
      sequence: fixture.snapshot.sequence + 1,
    };
    return ok(fixture.snapshot);
  },
} satisfies Partial<DesktopAPI>;

const api = new Proxy(implemented, {
  get(target, key, receiver) {
    if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
    return () => {
      fixture.unexpectedCalls.push(String(key));
      throw new Error(`Offline composer fixture forbids API ${String(key)}`);
    };
  },
}) as unknown as DesktopAPI;

createRoot(document.getElementById("root")!).render(<App api={api} />);
