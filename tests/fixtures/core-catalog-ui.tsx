// Deterministic UI-only fixture; never presented as an actual Core catalog.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { CoreCatalog } from "../../src/renderer/CoreCatalog";
import type { AppState, DesktopAPI } from "../../src/shared/contracts";
import type { CoreCatalogSnapshot } from "../../src/shared/core-catalog";
const w = window as any;
const clone = <T,>(x: T): T => structuredClone(x);
let flow: CoreCatalogSnapshot | null = null;
let resolve!: (s: unknown) => void;
w.catalog = {
  calls: [],
  finish: () => {
    flow!.busy = false;
    flow!.completedAt = Date.now();
    flow!.plugins = {
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
      marketplaces: [
        {
          name: "fixture",
          path: "/owned/marketplace.json",
          interface: null,
          plugins: Array.from({ length: 51 }, (_, n) => ({
            id: `fixture-${n}@fixture`,
            name: `fixture-${n}`,
            interface: {
              displayName: `Fixture ${n}`,
              shortDescription: "UI fixture only",
              longDescription: "x".repeat(1200),
            },
            installed: false,
            enabled: false,
            availability: "AVAILABLE",
            localVersion: "1.0.0",
            version: null,
            source: { type: "local", path: "/owned/plugin" },
          })),
        },
      ],
    } as any;
    flow!.apps = {
      nextCursor: null,
      data: [
        {
          id: "connector-fixture",
          name: "Connector UI fixture",
          description: "Configured does not mean callable",
          isAccessible: true,
          isEnabled: true,
        },
      ],
    } as any;
    flow!.installedApps = {
      apps: [
        {
          id: "connector-fixture",
          runtimeName: "Fixture",
          enabled: true,
          callable: false,
        },
        {
          id: "runtime-only",
          runtimeName: "Original runtime-only connector",
          enabled: false,
          callable: false,
        },
      ],
    };
    flow!.errors = [
      {
        method: "account/read",
        code: "FIXTURE_ACCOUNT_UNAVAILABLE",
        message: "Controlled partial account failure",
      },
    ];
    flow!.identityConflicts = [
      { kind: "plugin", marketplace: "fixture", id: "conflicting-plugin", occurrences: 2 },
      { kind: "app", id: "conflicting-app", occurrences: 3 },
    ];
    resolve({ ok: true, value: clone(flow) });
  },
};
const api = {
  coreCatalogIcon: async (key: { id: string }) => ({
    ok: true,
    value:
      key.id === "connector-fixture"
        ? {
            status: "ready",
            field: "iconDarkAssets.256_square",
            source: "https",
            sha256: "ui-fixture-not-a-live-provider",
            dataUrl: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><image href="https://must-not-fetch.invalid/remote.svg"/><rect x="4" y="4" width="40" height="40" rx="8" fill="#78b8de"/></svg>')}`,
          }
        : { status: "missing", message: "UI fixture has no original icon." },
  }),
  corePluginStatus: async () => ({ ok: true, value: null }),
  mcpAuthorizationStatus: async () => ({ ok: true, value: null }),
  coreCatalogStatus: async () => ({ ok: true, value: clone(flow) }),
  coreCatalogRead: async (
    providerId: string,
    workspaceId: string,
    remote: boolean,
  ) => {
    w.catalog.calls.push(["read", providerId, workspaceId, remote]);
    // Delay publication to reproduce the initial status-before-read race.
    await new Promise((r) => setTimeout(r, 70));
    flow = {
      id: `fixture-${w.catalog.calls.length}`,
      providerId,
      workspaceId,
      remote,
      scope: "provider-configuration",
      startedAt: Date.now(),
      busy: true,
      cancelled: false,
      plugins: null,
      apps: null,
      installedApps: null,
      errors: [],
    };
    return new Promise((r) => {
      resolve = r;
    });
  },
  coreCatalogCancel: async (id: string) => {
    if (flow?.id !== id) throw Error("Wrong fixture identity");
    w.catalog.calls.push(["cancel", id]);
    flow = { ...flow!, busy: false, cancelled: true, completedAt: Date.now() };
    resolve({ ok: true, value: clone(flow) });
    return { ok: true, value: clone(flow) };
  },
} as unknown as DesktopAPI;
const state = {
  engine: { providerId: "fixture-provider" },
  workspaces: [
    { id: "fixture-workspace", name: "Fixture workspace", path: "/owned" },
  ],
  integrations: [
    {
      id: "fixture-provider",
      name: "Controlled provider",
      enabled: true,
      kind: "provider",
    },
  ],
} as AppState;
function Fixture() {
  const [kind, setKind] = useState<"plugins" | "apps">("plugins");
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible(!visible)}>Toggle fixture view</button>
      <button onClick={() => setKind(kind === "plugins" ? "apps" : "plugins")}>
        Switch fixture catalog
      </button>
      {visible && (
        <CoreCatalog
          key={kind}
          api={api}
          state={state}
          busy={false}
          kind={kind}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
