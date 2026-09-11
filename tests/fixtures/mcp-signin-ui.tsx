// Component fixture only. Original Core OAuth is qualified separately.
import { createRoot } from "react-dom/client";
import { McpSignIn } from "../../src/renderer/McpSignIn";
import type {
  AppState,
  DesktopAPI,
  McpAuthorization,
} from "../../src/shared/contracts";
const w = window as unknown as {
  authCalls: string[];
  authComplete: () => void;
  authFail: () => void;
};
w.authCalls = [];
let flow: McpAuthorization | null = null,
  serial = 0;
w.authComplete = () => {
  if (flow)
    flow = { ...flow, status: "authorized", authorizationUrl: undefined };
};
w.authFail = () => {
  if (flow)
    flow = {
      ...flow,
      status: "failed",
      authorizationUrl: undefined,
      message: "Core rejected sign-in",
    };
};
const api = {
  mcpAuthorizationStatus: async () => ({ ok: true, value: flow }),
  mcpAuthorize: async (id: string, provider: string) => {
    w.authCalls.push(`start:${id}:${provider}`);
    flow = {
      id: `attempt-${++serial}`,
      integrationId: id,
      providerId: provider,
      serverName: "synora_fixture",
      status: "awaiting_browser",
      authorizationUrl:
        "https://auth.example.invalid/authorize?state=fixture-only",
      expiresAt: Date.now() + 180000,
    };
    return { ok: true, value: flow };
  },
  mcpAuthorizationOpen: async (id: string) => {
    w.authCalls.push(`open:${id}`);
    return { ok: true };
  },
  mcpAuthorizationCancel: async (id: string) => {
    w.authCalls.push(`cancel:${id}`);
    flow = {
      ...flow!,
      status: "cancelled",
      authorizationUrl: undefined,
      message: "Does not revoke existing provider grants",
    };
    return { ok: true, value: flow };
  },
} as unknown as DesktopAPI;
const state = {
  engine: { mode: "simulated" },
  integrations: [
    {
      id: "fixture",
      name: "Controlled OAuth MCP",
      kind: "mcp",
      executor: "http-mcp",
      enabled: true,
      auth: "oauth",
    },
    {
      id: "axiom",
      name: "Axiom namespace",
      kind: "provider",
      enabled: true,
      auth: "none",
    },
  ],
} as AppState;
createRoot(document.getElementById("root")!).render(
  <McpSignIn
    api={api}
    state={state}
    busy={false}
    web={location.hash === "#web"}
  />,
);
