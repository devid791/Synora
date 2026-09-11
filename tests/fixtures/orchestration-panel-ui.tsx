// Controlled renderer fixture. No Core process, provider or real host operations.
import { createRoot } from "react-dom/client";
import { OrchestrationPanel } from "../../src/renderer/OrchestrationPanel";
import type {
  AppState,
  DesktopAPI,
  ModelCapabilities,
  Result,
} from "../../src/shared/contracts";

const q = (
  window as unknown as {
    orchestrationFixture: {
      state: AppState;
      conversationId: string | null;
      busy: boolean;
      calls: Array<{ name: string; args: unknown[] }>;
      accepted: AppState[];
      errors: string[];
      failures: Record<string, number>;
      holdCatalogs: boolean;
      requests: Array<{
        id: string;
        resolve: (models: ModelCapabilities[]) => void;
        reject: (error: Error) => void;
      }>;
      catalogs: Record<string, ModelCapabilities[]>;
      render: () => void;
    };
  }
).orchestrationFixture;
const root = createRoot(document.getElementById("root")!);
const run = async <T,>(
  name: string,
  args: unknown[],
  result: () => T | Promise<T>,
): Promise<Result<T>> => {
  q.calls.push({ name, args });
  if (q.failures[name]) {
    q.failures[name]--;
    return {
      ok: false,
      error: { code: "FIXTURE", message: `Controlled ${name} failure` },
    };
  }
  return { ok: true, value: await result() };
};
const api = {
  engineModels: (id) =>
    run("engineModels", [id], () =>
      q.holdCatalogs
        ? new Promise<ModelCapabilities[]>((resolve, reject) =>
            q.requests.push({ id, resolve, reject }),
          )
        : (q.catalogs[id] ?? []),
    ),
  orchestrationConfigure: (id, plan) =>
    run("orchestrationConfigure", [id, plan], () => ({
      ...q.state,
      revision: q.state.revision + 1,
      conversations: q.state.conversations.map((c) =>
        c.id === id ? { ...c, orchestration: plan ?? undefined } : c,
      ),
    })),
  delegationCancel: (id, taskId) =>
    run("delegationCancel", [id, taskId], () => ({
      ...q.state,
      revision: q.state.revision + 1,
      delegations: q.state.delegations.map((t) =>
        t.id === taskId ? { ...t, status: "cancelled" as const } : t,
      ),
    })),
  delegationApprove: (...args) =>
    run("delegationApprove", args, () => undefined),
  delegationAnswer: (...args) => run("delegationAnswer", args, () => undefined),
  chooseWorkspace: (path) =>
    run("chooseWorkspace", [path], () => {
      const workspace = {
        id: "added",
        name: "Added folder",
        path: path ?? "/fixture/added",
      };
      q.state = {
        ...q.state,
        revision: q.state.revision + 1,
        workspaces: [...q.state.workspaces, workspace],
      };
      return workspace;
    }),
  state: () => run("state", [], () => q.state),
} satisfies Pick<
  DesktopAPI,
  | "engineModels"
  | "orchestrationConfigure"
  | "delegationCancel"
  | "delegationApprove"
  | "delegationAnswer"
  | "chooseWorkspace"
  | "state"
>;
q.render = () =>
  root.render(
    <OrchestrationPanel
      api={api as DesktopAPI}
      state={q.state}
      conversationId={q.conversationId}
      busy={q.busy}
      onState={(state) => {
        q.accepted.push(state);
        q.state = state;
        q.render();
      }}
      onError={(error) => q.errors.push(error)}
    />,
  );
q.render();
