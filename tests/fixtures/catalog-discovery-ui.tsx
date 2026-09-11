// Controlled rendering only; real public metadata is qualified separately.
import React from "react";
import { createRoot } from "react-dom/client";
import { CoreCatalog } from "../../src/renderer/CoreCatalog";
import type { AppState, DesktopAPI } from "../../src/shared/contracts";
const w = window as any;
w.catalogCalls = [];
let snapshot: any = null;
const state = {
  engine: { providerId: "axiom" },
  integrations: [
    {
      id: "axiom",
      name: "Axiom offline inference",
      kind: "provider",
      enabled: true,
    },
  ],
  workspaces: [{ id: "project", name: "Project", path: "/owned" }],
} as AppState;
const api = new Proxy(
  {},
  {
    get:
      (_target, method) =>
      async (...args: any[]) => {
        w.catalogCalls.push({ method, args });
        if (method === "coreCatalogRead") {
          if (w.catalogFail)
            return {
              ok: false,
              error: { message: "Directory temporarily unavailable" },
            };
          snapshot = {
            id: "catalog",
            providerId: "axiom",
            workspaceId: "project",
            remote: false,
            busy: false,
            startedAt: 1,
            completedAt: 2,
            errors: [],
            accountMode: null,
            discoveryOnlyPluginIds: ["gmail@openai-curated"],
            apps: { data: [] },
            installedApps: { apps: [] },
            plugins: {
              marketplaceLoadErrors: [],
              marketplaces: [
                {
                  name: "openai-curated",
                  plugins: [
                    {
                      id: "gmail@openai-curated",
                      name: "gmail",
                      installed: false,
                      enabled: false,
                      availability: "AVAILABLE",
                      interface: {
                        displayName: "Gmail",
                        shortDescription: "Controlled public-entry fixture",
                      },
                    },
                  ],
                },
              ],
            },
          };
          return { ok: true, value: snapshot };
        }
        if (method === "coreCatalogStatus")
          return { ok: true, value: snapshot };
        if (
          ["corePluginStatus", "mcpAuthorizationStatus"].includes(
            String(method),
          )
        )
          return { ok: true, value: null };
        if (method === "coreCatalogIcon")
          return {
            ok: true,
            value: {
              status: "missing",
              message: "Fixture has no third-party image",
            },
          };
        throw Error(`Unexpected ${String(method)}`);
      },
  },
) as DesktopAPI;
createRoot(document.getElementById("root")!).render(
  <CoreCatalog api={api} state={state} busy={false} kind="plugins" />,
);
