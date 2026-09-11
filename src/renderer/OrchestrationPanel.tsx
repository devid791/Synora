import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type {
  AppState,
  DesktopAPI,
  Integration,
  ModelCapabilities,
  Result,
  Workspace,
} from "../shared/contracts";
import type { WorkerDefinition } from "../shared/orchestration";
import { resolveModelSelection } from "../shared/model-selection";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
import "./OrchestrationPanel.css";
import { OpenBeside } from "./ConversationSplit";

export interface OrchestrationPanelProps {
  api: DesktopAPI;
  state: AppState;
  conversationId: string | null;
  busy: boolean;
  onState: (s: AppState) => void;
  onError: (message: string) => void;
  onInspect?: (task: AppState["delegations"][number]) => void;
}

const unwrap = <T,>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isAxiom = (provider: Integration | undefined) =>
  !!provider && (!provider.providerType || provider.providerType === "axiom");
const providerKey = (provider: Integration) => JSON.stringify(provider);

// Each form owns its request lock. Supervisor activity must not disable a
// worker's cancellation or an operator response needed to unblock that worker.
function useOperation(onError: (message: string) => void) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (label: string, operation: () => Promise<void>) => {
    if (active.current) return false;
    active.current = true;
    setPending(label);
    setError("");
    try {
      await operation();
      return mounted.current;
    } catch (e) {
      if (mounted.current) {
        setError(message(e));
        onError(message(e));
      }
      return false;
    } finally {
      active.current = false;
      if (mounted.current) setPending("");
    }
  };
  return { pending, error, run, mounted };
}

type Catalog = {
  key: string;
  loading: boolean;
  models: ModelCapabilities[];
  error?: string;
};

function selectionProblem(
  worker: WorkerDefinition,
  provider: Integration | undefined,
  catalog: Catalog | undefined,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (!provider?.enabled || provider.kind !== "provider")
    return t("Select an enabled provider.");
  if (!catalog || catalog.key !== providerKey(provider))
    return t("Read this provider's current model catalog.");
  if (catalog.loading) return t("Reading the model catalog…");
  if (catalog.error) return t("Catalog unavailable. Retry before saving.");
  try {
    resolveModelSelection(
      worker.selection,
      provider.providerType,
      catalog.models,
    );
  } catch (e) {
    return message(e);
  }
  const model = catalog.models.find((m) => m.id === worker.selection.model);
  if (!model) return t("Select a model from the advertised catalog.");
  if (model.unavailableReason) return model.unavailableReason;
  if (
    worker.selection.effort &&
    !model.reasoning_efforts.includes(worker.selection.effort)
  )
    return t("The selected effort is no longer advertised. Choose again.");
  if (isAxiom(provider)) {
    if (
      !worker.selection.effort ||
      !model.reasoning_efforts.includes(worker.selection.effort)
    )
      return t("Select an advertised Axiom profile.");
    if (!model.context_window_options.includes(worker.selection.context ?? 0))
      return t("Select an advertised Axiom context.");
  } else if (worker.selection.context !== undefined) {
    return t("This model manages its context; reselect the model to clear the override.");
  }
  return "";
}

export function OrchestrationPanel(props: OrchestrationPanelProps) {
  const conversation = props.state.conversations.find(
    (c) => c.id === props.conversationId,
  );
  // A different conversation or externally saved plan must not inherit drafts,
  // acknowledgements or in-flight catalog responses from the previous one.
  return (
    <Panel
      key={`${props.conversationId}:${JSON.stringify(conversation?.orchestration)}`}
      {...props}
    />
  );
}

function Panel(props: OrchestrationPanelProps) {
  const { t, number } = useI18n(messages satisfies Messages);
  const { api, state, conversationId, busy, onError } = props;
  const conversation = state.conversations.find((c) => c.id === conversationId);
  const saved = conversation?.orchestration;
  const [workers, setWorkers] = useState<WorkerDefinition[]>(
    () => saved?.workers ?? [],
  );
  const sharingScope = JSON.stringify({
    supervisor: state.engine,
    providers: state.integrations.filter(
      (provider) =>
        provider.id === state.engine.providerId ||
        workers.some((w) => w.selection.providerId === provider.id),
    ),
    parentWorkspace: conversation?.workspaceId,
    workers: workers.map(({ contractHash: _hash, ...worker }) => worker),
  });
  const [confirmedScope, setConfirmedScope] = useState<string | null>(() =>
    saved?.externalSharingConfirmed ? sharingScope : null,
  );
  const confirmed = confirmedScope === sharingScope;
  const setConfirmed = (value: boolean) =>
    setConfirmedScope(value ? sharingScope : null);
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const requests = useRef<Record<string, number>>({});
  const nextWorker = useRef(1);
  const [workspacePath, setWorkspacePath] = useState("");
  const [addedWorkspaces, setAddedWorkspaces] = useState<Workspace[]>([]);
  const operation = useOperation(onError);
  const latest = useRef(props);
  latest.current = props;
  const applyState = (next: AppState) => {
    if (
      operation.mounted.current &&
      next.revision >= latest.current.state.revision
    )
      latest.current.onState(next);
  };
  const tasks = (state.delegations ?? []).filter(
    (task) => task.parentConversationId === conversationId,
  );
  const providers = state.integrations.filter(
    (p) => p.kind === "provider" && p.enabled,
  );
  const supervisor = state.integrations.find(
    (p) => p.kind === "provider" && p.id === state.engine.providerId,
  );
  const workspaces = [
    ...state.workspaces,
    ...addedWorkspaces.filter(
      (w) => !state.workspaces.some((s) => s.id === w.id),
    ),
  ];
  const lockReason = !conversation
    ? t("Create or select a new conversation first.")
    : conversation.binding ||
        conversation.messages.length ||
        conversation.activity.length ||
        tasks.length
      ? t("Worker configuration is locked after history, delegation or an engine binding exists. Use a new conversation.")
      : "";
  const disabled = !!lockReason || busy || !!operation.pending;
  const problem =
    lockReason ||
    (busy ? t("Finish the active operation before configuring workers.") : "") ||
    (state.engine.mode !== "live" || !supervisor?.enabled || !state.engine.model
      ? t("Select an enabled live supervisor provider and model above first.")
      : "") ||
    (!conversation?.workspaceId
      ? t("Choose the supervisor conversation's workspace first.")
      : "") ||
    (!workers.length
      ? t("Add at least one worker to enable orchestration.")
      : "") ||
    workers
      .map((w) => {
        const p = providers.find((p) => p.id === w.selection.providerId);
        const selectedWorkspace = workspaces.find(
          (s) => s.id === w.workspaceId,
        );
        const parentWorkspace = workspaces.find(
          (s) => s.id === conversation?.workspaceId,
        );
        return (
          (!w.name.trim() ? t("{worker}: Enter a worker name.", { worker: w.id }) : "") ||
          selectionProblem(w, p, catalogs[w.selection.providerId], t) ||
          (!selectedWorkspace ? t("{worker}: Choose a worker workspace.", { worker: w.name }) : "") ||
          (w.workspaceId === conversation?.workspaceId ||
          (selectedWorkspace &&
            parentWorkspace?.path === selectedWorkspace.path)
            ? t("{worker}: Use a workspace separate from the supervisor.", { worker: w.name })
            : "") ||
          (workers.some(
            (other) =>
              other.id !== w.id &&
              (other.workspaceId === w.workspaceId ||
                (selectedWorkspace &&
                  workspaces.find((s) => s.id === other.workspaceId)?.path ===
                    selectedWorkspace.path)),
          )
            ? t("{worker}: Each worker needs a separate workspace.", { worker: w.name })
            : "") ||
          (!Number.isInteger(w.timeoutMs) ||
          w.timeoutMs < 1000 ||
          w.timeoutMs > 3600000
            ? t("{worker}: Timeout must be between {min} and {max} seconds.", { worker: w.name, min: number(1), max: number(3600) })
            : "")
        );
      })
      .find(Boolean) ||
    (!confirmed
      ? t("Confirm external sharing before enabling orchestration.")
      : "");

  const updateWorker = (id: string, patch: Partial<WorkerDefinition>) => {
    setWorkers((rows) =>
      rows.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    );
    // Every changed recipient/plan needs a fresh explicit acknowledgement.
    setConfirmed(false);
  };
  const readCatalog = async (providerId: string) => {
    const provider = providers.find((p) => p.id === providerId);
    if (disabled || !provider) return;
    const key = providerKey(provider);
    const request = (requests.current[providerId] ?? 0) + 1;
    requests.current[providerId] = request;
    setCatalogs((all) => ({
      ...all,
      [providerId]: { key, loading: true, models: [] },
    }));
    try {
      const models = unwrap(await api.engineModels(providerId));
      if (
        !operation.mounted.current ||
        requests.current[providerId] !== request
      )
        return;
      setCatalogs((all) => ({
        ...all,
        [providerId]: { key, loading: false, models },
      }));
    } catch (e) {
      if (
        !operation.mounted.current ||
        requests.current[providerId] !== request
      )
        return;
      setCatalogs((all) => ({
        ...all,
        [providerId]: { key, loading: false, models: [], error: message(e) },
      }));
      onError(message(e));
    }
  };

  return (
    <section className="orchestration-panel" aria-label={t("Worker orchestration")}>
      <h2>{t("Supervisor and workers")}</h2>
      <p>
        {t("The model selected above is the supervisor. Workers below have independent provider, model and effort selections.")}
      </p>
      <dl className="orchestration-identity" aria-label={t("Selected supervisor")}>
        <dt>{t("Supervisor provider")}</dt>
        <dd>
          {supervisor?.name ?? t("Not selected")}{" "}
          {supervisor && <code>{supervisor.id}</code>}
        </dd>
        <dt>{t("Supervisor model")}</dt>
        <dd>{state.engine.model ?? t("Not selected")}</dd>
        <dt>{t("Supervisor effort / profile")}</dt>
        <dd>
          {state.engine.mode !== "live"
            ? t("Simulator — no live supervisor")
            : isAxiom(supervisor)
              ? state.preferences.profile
              : state.engine.reasoningEffort ||
                t("Provider default (no effort override)")}
        </dd>
        <dt>{t("Supervisor context")}</dt>
        <dd>
          {state.engine.mode !== "live"
            ? t("Not applicable")
            : isAxiom(supervisor)
              ? t("{count} tokens", { count: number(state.preferences.context) })
              : t("Model-managed by Core")}
        </dd>
      </dl>
      <div
        className="orchestration-scroll"
        role="region"
        aria-label={t("Orchestration controls and tasks")}
        tabIndex={0}
      >
        <details open={!lockReason}>
          <summary>
            {t("Worker configuration ·")}{" "}
            {saved ? t("{count} saved", { count: number(saved.workers.length) }) : t("single-provider mode")}
          </summary>
          {lockReason && <p>{lockReason}</p>}
          <form
            aria-label={t("Configure workers")}
            onSubmit={(event) => {
              event.preventDefault();
              if (disabled || problem || !conversationId) return;
              void operation.run("Saving worker configuration…", async () => {
                applyState(
                  unwrap(
                    await api.orchestrationConfigure(conversationId, {
                      workers: workers.map(
                        ({ id, name, selection, workspaceId, timeoutMs }) => ({
                          id,
                          name: name.trim(),
                          selection,
                          workspaceId,
                          timeoutMs,
                        }),
                      ),
                      externalSharingConfirmed: true,
                    }),
                  ),
                );
              });
            }}
          >
            <fieldset disabled={disabled}>
              <legend>{t("Independent workers")}</legend>
              <p>
                {t("Catalog access does not prove inference access. Each worker must use a separate workspace from its supervisor and every other worker; the service validates overlapping or aliased paths.")}
              </p>
              {!providers.length && (
                <p>{t("Enable a provider in Models & accounts first.")}</p>
              )}
              {workers.map((worker, index) => {
                const provider = providers.find(
                  (p) => p.id === worker.selection.providerId,
                );
                const storedCatalog = catalogs[worker.selection.providerId];
                const catalog =
                  provider && storedCatalog?.key === providerKey(provider)
                    ? storedCatalog
                    : undefined;
                const models = catalog?.models ?? [];
                const model = models.find(
                  (m) => m.id === worker.selection.model,
                );
                const axiom = isAxiom(provider);
                const issue = selectionProblem(worker, provider, catalog, t);
                const label = t("Worker {index}", { index: number(index + 1) });
                return (
                  <fieldset key={worker.id} className="orchestration-worker">
                    <legend>
                      {label} · {worker.name || worker.id}
                    </legend>
                    <p>
                      {t("Worker ID:")} <code>{worker.id}</code>
                    </p>
                    <div className="orchestration-fields">
                      <label>
                        {t("Name")}
                        <input
                          aria-label={t("{worker} name", { worker: label })}
                          value={worker.name}
                          required
                          maxLength={100}
                          onChange={(e) =>
                            updateWorker(worker.id, { name: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        {t("Provider")}
                        <select
                          aria-label={t("{worker} provider", { worker: label })}
                          value={provider?.id ?? ""}
                          onChange={(e) => {
                            const providerId = e.target.value;
                            updateWorker(worker.id, {
                              selection: { providerId, model: "" },
                            });
                            if (providerId) void readCatalog(providerId);
                          }}
                        >
                          <option value="">{t("Select an enabled provider")}</option>
                          {providers.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} · {p.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {t("Advertised model")}
                        <select
                          aria-label={t("{worker} model", { worker: label })}
                          value={model?.id ?? ""}
                          disabled={!models.length || catalog?.loading}
                          onChange={(e) => {
                            const selected = models.find(
                              (m) =>
                                m.id === e.target.value &&
                                m.unavailableReason === undefined,
                            );
                            updateWorker(worker.id, {
                              selection: {
                                providerId: worker.selection.providerId,
                                model: selected?.id ?? "",
                              },
                            });
                          }}
                        >
                          <option value="">
                            {catalog?.loading
                              ? t("Reading catalog…")
                              : t("Select an advertised model")}
                          </option>
                          {models.map((m) => (
                            <option
                              key={m.id}
                              value={m.id}
                              disabled={m.unavailableReason !== undefined}
                            >
                              {m.coreModel?.displayName
                                ? `${m.coreModel.displayName} · `
                                : ""}
                              {m.id}
                              {m.unavailableReason
                                ? ` · ${m.unavailableReason}`
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        {axiom ? t("Axiom profile") : t("Model reasoning effort")}
                        <select
                          aria-label={t("{worker} effort", { worker: label })}
                          value={
                            model?.reasoning_efforts.includes(
                              worker.selection.effort ?? "",
                            )
                              ? worker.selection.effort
                              : ""
                          }
                          disabled={
                            !model ||
                            !model.reasoning_efforts.length ||
                            !!model.unavailableReason
                          }
                          onChange={(e) => {
                            const { effort: _effort, ...selection } =
                              worker.selection;
                            updateWorker(worker.id, {
                              selection: {
                                ...selection,
                                ...(e.target.value
                                  ? { effort: e.target.value }
                                  : {}),
                              },
                            });
                          }}
                        >
                          <option value="">
                            {axiom
                              ? t("Select an advertised profile")
                              : t("Provider default (no effort override)")}
                          </option>
                          {model?.reasoning_efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </select>
                      </label>
                      {axiom && (
                        <label>
                          {t("Axiom context")}
                          <select
                            aria-label={t("{worker} context", { worker: label })}
                            value={
                              model?.context_window_options.includes(
                                worker.selection.context ?? 0,
                              )
                                ? worker.selection.context
                                : ""
                            }
                            disabled={
                              !model?.context_window_options.length ||
                              !!model?.unavailableReason
                            }
                            onChange={(e) => {
                              const { context: _context, ...selection } =
                                worker.selection;
                              updateWorker(worker.id, {
                                selection: {
                                  ...selection,
                                  ...(e.target.value
                                    ? { context: Number(e.target.value) }
                                    : {}),
                                },
                              });
                            }}
                          >
                            <option value="">
                              {t("Select an advertised context")}
                            </option>
                            {model?.context_window_options.map((context) => (
                              <option key={context} value={context}>
                                {t("{count} tokens", { count: number(context) })}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <label>
                        {t("Separate workspace")}
                        <select
                          aria-label={t("{worker} workspace", { worker: label })}
                          value={worker.workspaceId}
                          required
                          onChange={(e) =>
                            updateWorker(worker.id, {
                              workspaceId: e.target.value,
                            })
                          }
                        >
                          <option value="">{t("Select a separate workspace")}</option>
                          {workspaces.map((w) => {
                            const inUse =
                              w.id === conversation?.workspaceId ||
                              workspaces.find(
                                (p) => p.id === conversation?.workspaceId,
                              )?.path === w.path ||
                              workers.some(
                                (other) =>
                                  other.id !== worker.id &&
                                  (other.workspaceId === w.id ||
                                    workspaces.find(
                                      (s) => s.id === other.workspaceId,
                                    )?.path === w.path),
                              );
                            return (
                              <option key={w.id} value={w.id} disabled={inUse}>
                                {w.name} · {w.path}
                                {inUse ? t(" · already assigned") : ""}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <label>
                        {t("Timeout (seconds)")}
                        <input
                          aria-label={t("{worker} timeout seconds", { worker: label })}
                          type="number"
                          min={1}
                          max={3600}
                          step={0.001}
                          required
                          value={worker.timeoutMs / 1000 || ""}
                          onChange={(e) =>
                            updateWorker(worker.id, {
                              timeoutMs: Math.round(
                                Number(e.target.value) * 1000,
                              ),
                            })
                          }
                        />
                      </label>
                    </div>
                    <p>
                      {t("Selected:")} {worker.selection.providerId || t("no provider")} /{" "}
                      {worker.selection.model || t("no model")} {t("· effort:")}{" "}
                      {worker.selection.effort || t("no override")}
                      {worker.selection.context !== undefined
                        ? t(" · context: {count}", { count: number(worker.selection.context) })
                        : ""}
                    </p>
                    {model && !axiom && (
                      <p>
                        {t("Model-managed context:")}{" "}
                        {model.context_window === null
                          ? t("window not reported")
                          : t("{count} tokens reported", { count: number(model.context_window) })}
                        {t(". Core manages history and compaction; no Axiom context/profile override is sent.")}
                      </p>
                    )}
                    {model?.default_reasoning_effort && (
                      <p>
                        {t("Advertised default effort:")}{" "}
                        {model.default_reasoning_effort}
                      </p>
                    )}
                    {issue && (
                      <p role={catalog?.error ? "alert" : undefined}>
                        {issue}
                        {catalog?.error ? ` ${catalog.error}` : ""}
                      </p>
                    )}
                    <div className="orchestration-actions">
                      <button
                        type="button"
                        disabled={!provider || catalog?.loading}
                        onClick={() =>
                          void readCatalog(worker.selection.providerId)
                        }
                      >
                        {catalog?.loading
                          ? t("Reading catalog…")
                          : t("Read / refresh model catalog")}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setWorkers((rows) =>
                            rows.filter((w) => w.id !== worker.id),
                          );
                          setConfirmed(false);
                        }}
                      >
                        {t("Remove worker {index}", { index: number(index + 1) })}
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <button
                type="button"
                disabled={!providers.length}
                onClick={() => {
                  let id: string;
                  do {
                    id = `worker_${nextWorker.current++}`;
                  } while (workers.some((w) => w.id === id));
                  setWorkers((rows) => [
                    ...rows,
                    {
                      id,
                      name: t("Worker {index}", { index: number(rows.length + 1) }),
                      selection: { providerId: "", model: "" },
                      workspaceId: "",
                      timeoutMs: 300000,
                    },
                  ]);
                  setConfirmed(false);
                }}
              >
                {t("Add worker")}
              </button>
              <details>
                <summary>{t("Add a worker workspace")}</summary>
                <p>
                  {t("Choose an existing folder. On web, enter its absolute path on the companion service host. This does not change the supervisor workspace.")}
                </p>
                <label>
                  {t("Workspace path (optional for native dialog)")}
                  <input
                    aria-label={t("New worker workspace path")}
                    value={workspacePath}
                    onChange={(e) => setWorkspacePath(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    void operation.run("Choosing a workspace…", async () => {
                      const workspace = unwrap(
                        await api.chooseWorkspace(
                          workspacePath.trim() || undefined,
                        ),
                      );
                      if (!workspace || !operation.mounted.current) return;
                      setAddedWorkspaces((rows) => [
                        ...rows.filter((w) => w.id !== workspace.id),
                        workspace,
                      ]);
                      setWorkspacePath("");
                      applyState(unwrap(await api.state()));
                    })
                  }
                >
                  {t("Choose / add workspace")}
                </button>
              </details>
              <label className="orchestration-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <span>
                  {t("I confirm that delegated task content, local workspace material included in tasks, and worker results may be sent to the selected supervisor and configured worker providers, including external providers. Credentials must stay in account settings, never in prompts or task content.")}
                </span>
              </label>
              <p>
                {t("Saving enables callable workers for the supervisor; it does not start a task or transfer this chat's identity. Ask the supervisor to delegate from the conversation.")}
              </p>
              <div className="orchestration-actions">
                <button type="submit" disabled={!!problem}>
                  {t("Save worker configuration")}
                </button>
                <button
                  type="button"
                  disabled={!saved}
                  onClick={() => {
                    if (disabled || !conversationId) return;
                    void operation.run(
                      "Restoring single-provider mode…",
                      async () =>
                        applyState(
                          unwrap(
                            await api.orchestrationConfigure(
                              conversationId,
                              null,
                            ),
                          ),
                        ),
                    );
                  }}
                >
                  {t("Use single-provider mode")}
                </button>
              </div>
            </fieldset>
            {problem && <p>{problem}</p>}
            {operation.pending && <p role="status">{t(operation.pending)}</p>}
            {operation.error && <p role="alert">{operation.error}</p>}
          </form>
        </details>
        <h3>{t("Delegated tasks ·")} {number(tasks.length)}</h3>
        {!tasks.length && (
          <p>{t("No delegated tasks reported for this conversation.")}</p>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            api={api}
            state={state}
            onState={applyState}
            onError={onError}
            onInspect={props.onInspect}
          />
        ))}
      </div>
    </section>
  );
}

type Task = AppState["delegations"][number];
type TaskProps = Pick<
  OrchestrationPanelProps,
  "api" | "state" | "onState" | "onError" | "onInspect"
> & { task: Task };
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const activeTask = (task: Task) =>
  task.status === "queued" || task.status === "running";
const taskAnchor = (task: Task) =>
  `delegated-task-${encodeURIComponent(task.parentConversationId)}-${encodeURIComponent(task.id)}`;
const requestIdentity = {
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
};
const approvalSchema = z.object({
  id: z.string().min(1),
  params: z.object(requestIdentity).passthrough(),
});
const questionSchema = z.object({
  id: z.string().min(1),
  params: z.object({
    ...requestIdentity,
    isBlocking: z.boolean(),
    questions: z
      .array(
        z.object({
          id: z.string().min(1),
          header: z.string(),
          question: z.string(),
          isOther: z.boolean(),
          isSecret: z.boolean(),
          options: z
            .array(
              z.object({ label: z.string().min(1), description: z.string() }),
            )
            .nullable(),
        }),
      )
      .min(1)
      .refine((rows) => new Set(rows.map((q) => q.id)).size === rows.length),
  }),
});
type Approval = z.infer<typeof approvalSchema>;
type Question = z.infer<typeof questionSchema>;
const matchesTask = (
  task: Task,
  params: { threadId: string; turnId: string },
) => params.threadId === task.threadId && params.turnId === task.turnId;

function ReportedText({ label, text }: { label: string; text: string }) {
  const { t, locale, number } = useI18n(messages satisfies Messages);
  if (!text) return <p>{t("{label}: not reported.", { label })}</p>;
  return (
    <>
      <p>
        <strong>{label}</strong>
      </p>
      <pre>{text.length > 1200 ? `${text.slice(0, 1200)}…` : text}</pre>
      {text.length > 1200 && (
        <details>
          <summary>
            {t("Full {label} ({count} characters)", { label: label.toLocaleLowerCase(locale), count: number(text.length) })}
          </summary>
          <pre tabIndex={0}>{text}</pre>
        </details>
      )}
    </>
  );
}

// Opaque durable payloads are not trusted as typed Core requests. Render only
// validated identities for actions; keep unfamiliar data visible but inert.
function TaskCard({ task, api, state, onState, onError, onInspect }: TaskProps) {
  const { t, locale, number } = useI18n(messages satisfies Messages);
  const textValue = (value: unknown) =>
    typeof value === "string" ? value : t("Not reported");
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? number(value)
      : t("Not reported");
  const date = (value: number) =>
    Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
      ? new Date(value).toLocaleString(locale === "pt" ? "pt-PT" : locale)
      : t("Not reported");
  const operation = useOperation(onError);
  const [cancelled, setCancelled] = useState(false);
  const worker = state.conversations
    .find((c) => c.id === task.parentConversationId)
    ?.orchestration?.workers.find((w) => w.id === task.workerId);
  const provider = state.integrations.find(
    (p) => p.id === worker?.selection.providerId,
  );
  const payload = record(task.approval);
  const approval = approvalSchema.safeParse(payload.approval);
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((q) => questionSchema.safeParse(q))
    : [];
  const actionable = activeTask(task) && !cancelled;
  const core = record(record(task.tokenUsage).core);
  const total = record(core.total);
  const axiom = record(task.tokenUsage).axiom;
  const observations = Array.isArray(axiom)
    ? axiom.map(record).filter((r) => r.source === "axiom-response")
    : [];
  const invalidRequest =
    (payload.approval != null &&
      (!approval.success || !matchesTask(task, approval.data.params))) ||
    (payload.questions != null && !Array.isArray(payload.questions)) ||
    questions.some((q) => !q.success || !matchesTask(task, q.data.params));
  const priorTask = task.revisesTaskId
    ? state.delegations.find(
        (prior) =>
          prior.id === task.revisesTaskId &&
          prior.id !== task.id &&
          prior.parentConversationId === task.parentConversationId,
      )
    : undefined;
  return (
    <article
      id={taskAnchor(task)}
      className="orchestration-task"
      aria-label={t("Delegated task {name}", { name: task.name })}
      tabIndex={-1}
    >
      <h4>
        {task.name} ·{" "}
        {task.status === "unknown"
          ? t("Unknown outcome — not known to be running")
          : task.status}
      </h4>
      {onInspect && <OpenBeside open={() => onInspect(task)} />}
      <p>
        {t("Worker:")} {worker?.name ?? t("Name not reported")} ·{" "}
        <code>{task.workerId}</code>
      </p>
      <p>
        {t("Task ID:")} <code>{task.id}</code>
      </p>
      {task.revisesTaskId && (
        <div className="orchestration-revision" tabIndex={0}>
          <p>
            {t("Revises task:")}{" "}
            {priorTask ? (
              <a href={`#${encodeURIComponent(taskAnchor(priorTask))}`}>
                <code>{task.revisesTaskId}</code>
              </a>
            ) : (
              <>
                <code>{task.revisesTaskId}</code> {t("· Prior task is not available in this conversation.")}
              </>
            )}
          </p>
          <p>
            {t("Follow-up only; results are not automatically merged or accepted.")}
          </p>
        </div>
      )}
      {worker && (
        <p>
          {t("Configured provider:")} {provider?.name ?? worker.selection.providerId} ·{" "}
          <code>{worker.selection.providerId}</code> / {worker.selection.model}{" "}
          {t("· effort:")} {worker.selection.effort || t("provider default")} ·{" "}
          {worker.selection.context === undefined
            ? t("model-managed context")
            : t("{count} context tokens", { count: number(worker.selection.context) })}
        </p>
      )}
      {task.status === "unknown" && (
        <p>
          {t("The previous execution was not reconciled. Completion and process liveness are unconfirmed; this panel does not replay it.")}
        </p>
      )}
      {task.error && <ReportedText label={t("Worker error")} text={task.error} />}
      <ReportedText label={t("Assigned task")} text={task.task} />
      <ReportedText
        label={
          task.status === "completed"
            ? t("Worker result")
            : t("Reported output (not a completed result)")
        }
        text={task.result}
      />
      {(task.review || task.status === "completed") && (
        <section
          className="orchestration-review"
          aria-label={t("Supervisor review")}
        >
          <p>
            {t("Supervisor review:")}{" "}
            <strong>
              {task.review
                ? task.review.verdict === "accepted"
                  ? t("Accepted")
                  : t("Changes requested")
                : t("Pending")}
            </strong>
          </p>
          {task.review ? (
            <>
              <p>{t("Reviewed at:")} {date(task.review.at)}</p>
              <pre tabIndex={0} aria-label={t("Review summary")}>
                {task.review.summary}
              </pre>
              <details>
                <summary>{t("Original review identity")}</summary>
                <dl
                  className="orchestration-identity orchestration-review-identity"
                  aria-label={t("Original review identity")}
                  tabIndex={0}
                >
                  {Object.entries({
                    "Review call": task.review.callId,
                    "Review parent Core thread": task.review.parentThreadId,
                    "Review parent turn": task.review.parentTurnId,
                  }).map(([label, value]) => (
                    <div className="orchestration-pair" key={label}>
                      <dt>{t(label)}</dt>
                      <dd>
                        <code>{value}</code>
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </>
          ) : (
            <p>
              {t("No supervisor review recorded. Worker completion is not acceptance.")}
            </p>
          )}
        </section>
      )}
      <details>
        <summary>{t("Real identities and timing")}</summary>
        <dl className="orchestration-identity">
          {Object.entries({
            "Parent conversation": task.parentConversationId,
            "Parent Core thread": task.parentThreadId,
            "Parent turn": task.parentTurnId,
            "Delegation call": task.callId,
            "Worker Core thread": task.threadId ?? t("Not reported"),
            "Worker Core session": task.sessionId ?? t("Not reported"),
            "Worker turn": task.turnId ?? t("Not reported"),
            "Configured workspace":
              state.workspaces.find((w) => w.id === worker?.workspaceId)
                ?.path ?? t("Not reported"),
            Created: date(task.createdAt),
            "Last update": date(task.updatedAt),
            Deadline: date(task.deadlineAt),
          }).map(([label, value]) => (
            <div className="orchestration-pair" key={label}>
              <dt>{t(label)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      <details>
        <summary>{t("Reported worker usage and activity")}</summary>
        <p>
          {t("Core token usage is scoped to this worker, not the supervisor or live GPU/KV state. Missing counts are not zero.")}
        </p>
        {Object.keys(total).length ? (
          <dl className="orchestration-identity">
            {Object.entries({
              "Input tokens": total.inputTokens,
              "Cached input tokens": total.cachedInputTokens,
              "Cache write tokens": total.cacheWriteInputTokens,
              "Output tokens": total.outputTokens,
              "Reasoning output tokens": total.reasoningOutputTokens,
              "Total tokens": total.totalTokens,
            }).map(([label, value]) => (
              <div className="orchestration-pair" key={label}>
                <dt>{t(label)}</dt>
                <dd>{count(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>{t("Core token usage not reported.")}</p>
        )}
        {!!observations.length && (
          <details>
            <summary>
              {t("Axiom response observations ·")} {number(observations.length)}
            </summary>
            <p>
              {t("Original Axiom response counts, separate from Core usage; not added together.")}
            </p>
            {observations.map((r, i) => (
              <dl
                className="orchestration-identity"
                key={`${textValue(r.responseId)}:${i}`}
              >
                {Object.entries({
                  "Response ID": textValue(r.responseId),
                  Session: textValue(r.sessionId),
                  Thread: textValue(r.threadId),
                  Turn: textValue(r.turnId),
                  Model: textValue(r.model),
                  Profile: textValue(r.profile),
                  "Input tokens": count(r.inputTokens),
                  "Output tokens": count(r.outputTokens),
                  "Thinking tokens": count(r.thinkingTokens),
                  "Total tokens": count(r.totalTokens),
                  "Prefill seconds": count(r.prefillSeconds),
                  "Decode seconds": count(r.decodeSeconds),
                }).map(([label, value]) => (
                  <div className="orchestration-pair" key={label}>
                    <dt>{t(label)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ))}
          </details>
        )}
        {!task.items?.length ? (
          <p>{t("No worker activity items reported.")}</p>
        ) : (
          <ul>
            {task.items.map((item, index) => {
              const value = record(item);
              return (
                <li key={`${textValue(value.id)}:${index}`}>
                  {textValue(value.type)} {t("· ID:")}{" "}
                  <code>{textValue(value.id)}</code>
                  {typeof value.status === "string" ? ` · ${value.status}` : ""}
                </li>
              );
            })}
          </ul>
        )}
      </details>
      {invalidRequest && (
        <p role="alert">
          {t("A worker request has missing, invalid or mismatched identity. It cannot be answered safely from this snapshot.")}
        </p>
      )}
      {actionable &&
        approval.success &&
        matchesTask(task, approval.data.params) && (
          <WorkerApproval
            key={`${task.id}:${approval.data.id}`}
            task={task}
            request={approval.data}
            api={api}
            onError={onError}
          />
        )}
      {actionable &&
        questions.map((q) =>
          q.success && matchesTask(task, q.data.params) ? (
            <WorkerQuestion
              key={`${task.id}:${q.data.id}`}
              task={task}
              request={q.data}
              api={api}
              onError={onError}
            />
          ) : null,
        )}
      {!activeTask(task) && (approval.success || questions.length > 0) && (
        <p>
          {t("Historical worker requests are inactive; no response is sent to a terminal or unknown execution.")}
        </p>
      )}
      {activeTask(task) && (
        <button
          type="button"
          disabled={!!operation.pending || cancelled}
          onClick={() => {
            if (!actionable) return;
            void operation.run(
              "Cancelling worker and waiting for cleanup…",
              async () => {
                const next = unwrap(
                  await api.delegationCancel(
                    task.parentConversationId,
                    task.id,
                  ),
                );
                if (operation.mounted.current) {
                  setCancelled(true);
                  onState(next);
                }
              },
            );
          }}
        >
          {t("Cancel this worker task")}
        </button>
      )}
      {cancelled && (
        <p role="status">
          {t("Cancellation acknowledged; waiting for the reported task state.")}
        </p>
      )}
      {operation.pending && <p role="status">{t(operation.pending)}</p>}
      {operation.error && <p role="alert">{operation.error}</p>}
    </article>
  );
}

type RequestProps = Pick<TaskProps, "api" | "task" | "onError">;

function WorkerApproval({
  task,
  request,
  api,
  onError,
}: RequestProps & { request: Approval }) {
  const { t } = useI18n(messages satisfies Messages);
  const operation = useOperation(onError);
  const [sent, setSent] = useState(false);
  // Unknown/new approval fields remain visible, with no JSON dump and no
  // implicit grant. If the payload is too deep/large, approval is disabled.
  const entries = approvalEntries(request.params);
  return (
    <form
      aria-label={t("Worker approval {id}", { id: request.id })}
      onSubmit={(e) => e.preventDefault()}
    >
      <fieldset disabled={!!operation.pending || sent}>
        <legend>{t("Worker approval ·")} {task.name}</legend>
        <p>
          {t("Request ID:")} <code>{request.id}</code>{t(". This decision applies only to this worker task and request.")}
        </p>
        <div className="orchestration-approval-data" tabIndex={0}>
          <dl>
            {entries.rows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <pre>{value}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {!entries.complete && (
          <p role="alert">
            {t("Approval details exceed the safe preview limit. Approval is disabled; deny or cancel the worker to review safely.")}
          </p>
        )}
        <div className="orchestration-actions">
          {[false, true].map((approved) => (
            <button
              key={String(approved)}
              type="button"
              disabled={approved && !entries.complete}
              onClick={() => {
                if (
                  !activeTask(task) ||
                  !matchesTask(task, request.params) ||
                  sent
                )
                  return;
                void operation.run(
                  "Sending worker approval decision…",
                  async () => {
                    unwrap(
                      await api.delegationApprove(
                        task.parentConversationId,
                        task.id,
                        request.id,
                        approved,
                      ),
                    );
                    if (operation.mounted.current) setSent(true);
                  },
                );
              }}
            >
              {approved
                ? t("Approve this worker request")
                : t("Deny this worker request")}
            </button>
          ))}
        </div>
      </fieldset>
      {sent && (
        <p role="status">{t("Decision accepted; waiting for the worker update.")}</p>
      )}
      {operation.pending && <p role="status">{t(operation.pending)}</p>}
      {operation.error && <p role="alert">{operation.error}</p>}
    </form>
  );
}

function approvalEntries(value: unknown) {
  const rows: [string, string][] = [];
  let complete = true;
  const visit = (entry: unknown, path: string, depth: number) => {
    if (rows.length >= 100 || depth > 6) {
      complete = false;
      return;
    }
    if (entry === null || entry === undefined) return;
    if (typeof entry === "object") {
      for (const [key, item] of Object.entries(entry))
        visit(item, path ? `${path}.${key}` : key, depth + 1);
    } else if (["string", "number", "boolean"].includes(typeof entry)) {
      const text = String(entry);
      if (text.length > 16000) complete = false;
      rows.push([path, text.slice(0, 16000)]);
    } else complete = false;
  };
  visit(value, "", 0);
  return { rows, complete };
}

function WorkerQuestion({
  task,
  request,
  api,
  onError,
}: RequestProps & { request: Question }) {
  const { t } = useI18n(messages satisfies Messages);
  const operation = useOperation(onError);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [sent, setSent] = useState(false);
  const valid = request.params.questions.every((q) => {
    const answer = answers[q.id];
    return (
      !!answer?.trim() &&
      (!q.options?.length ||
        q.isSecret ||
        (q.isOther && custom[q.id]) ||
        q.options.some((o) => o.label === answer))
    );
  });
  return (
    <form
      aria-label={t("Worker question {id}", { id: request.id })}
      onSubmit={(e) => {
        e.preventDefault();
        if (
          !valid ||
          sent ||
          !activeTask(task) ||
          !matchesTask(task, request.params)
        )
          return;
        void operation.run("Sending worker answers…", async () => {
          unwrap(
            await api.delegationAnswer(
              task.parentConversationId,
              task.id,
              request.id,
              Object.fromEntries(
                request.params.questions.map((q) => [q.id, [answers[q.id]]]),
              ),
            ),
          );
          if (operation.mounted.current) {
            setSent(true);
            setAnswers({});
          }
        });
      }}
    >
      <fieldset disabled={!!operation.pending || sent}>
        <legend>
          {request.params.isBlocking
            ? t("Worker needs your answer")
            : t("Optional worker question")}{" "}
          · {task.name}
        </legend>
        <p>
          {t("Request:")} <code>{request.id}</code> {t("· thread:")}{" "}
          <code>{request.params.threadId}</code> {t("· turn:")}{" "}
          <code>{request.params.turnId}</code> {t("· item:")}{" "}
          <code>{request.params.itemId}</code>
        </p>
        {request.params.questions.map((q) => (
          <fieldset key={q.id}>
            <legend>{q.header}</legend>
            <p>{q.question}</p>
            {!q.isSecret &&
              q.options?.map((option) => (
                <label key={option.label} className="orchestration-check">
                  <input
                    type="radio"
                    name={`${task.id}:${request.id}:${q.id}`}
                    checked={!custom[q.id] && answers[q.id] === option.label}
                    onChange={() => {
                      setCustom((all) => ({ ...all, [q.id]: false }));
                      setAnswers((all) => ({ ...all, [q.id]: option.label }));
                    }}
                  />
                  <span>
                    {option.label}
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            {!q.isSecret && !!q.options?.length && q.isOther && (
              <label className="orchestration-check">
                <input
                  type="radio"
                  name={`${task.id}:${request.id}:${q.id}`}
                  checked={!!custom[q.id]}
                  onChange={() => {
                    setCustom((all) => ({ ...all, [q.id]: true }));
                    setAnswers((all) => ({ ...all, [q.id]: "" }));
                  }}
                />
                {t("Custom answer")}
              </label>
            )}
            {(q.isSecret || !q.options?.length || custom[q.id]) && (
              <label>
                {q.isSecret ? t("Private answer") : t("Your answer")}
                <input
                  aria-label={t("Worker answer: {header}", { header: q.header })}
                  type={q.isSecret ? "password" : "text"}
                  autoComplete="off"
                  required
                  maxLength={16000}
                  value={answers[q.id] ?? ""}
                  onChange={(e) =>
                    setAnswers((all) => ({ ...all, [q.id]: e.target.value }))
                  }
                />
              </label>
            )}
            {q.isSecret && (
              <p>
                {t("Sent to this worker's provider when submitted. Do not enter account credentials; configure those in Models & accounts.")}
              </p>
            )}
          </fieldset>
        ))}
        <button type="submit" disabled={!valid}>
          {t("Send worker answers")}
        </button>
      </fieldset>
      {sent && (
        <p role="status">{t("Answers accepted; waiting for the worker update.")}</p>
      )}
      {operation.pending && <p role="status">{t(operation.pending)}</p>}
      {operation.error && <p role="alert">{operation.error}</p>}
    </form>
  );
}
