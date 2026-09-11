import {
  providerRuntimeLabel,
  providerUsesCoreModel,
} from "../shared/provider-registry";
import { useRef, useState, useEffect } from "react";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
import type {
  AppState,
  DesktopAPI,
  EngineSnapshot,
  Result,
  NativeToolSetup,
} from "../shared/contracts";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
type Models =
  Awaited<ReturnType<DesktopAPI["engineModels"]>> extends Result<infer T>
    ? T
    : never;
export function EngineSettings({
  api,
  state,
  busy,
  applied,
  operationPending = false,
  runOperation,
  servicePlatform,
}: {
  api: DesktopAPI;
  state: AppState;
  busy: boolean;
  applied: (s: EngineSnapshot) => Promise<void>;
  operationPending?: boolean;
  runOperation?: (fn: () => Promise<void>, label: string) => Promise<void>;
  servicePlatform?: string;
}) {
  const { t, number } = useI18n(messages);
  const [provider, setProvider] = useState(state.engine.providerId ?? "");
  const [model, setModel] = useState(state.engine.model ?? "");
  const [effort, setEffort] = useState(state.engine.reasoningEffort ?? "");
  const providerType = state.integrations.find(
    (p) => p.id === provider,
  )?.providerType;
  const openAi = providerUsesCoreModel(providerType);
  const label =
    providerType === "compatible"
      ? t("Compatible endpoint")
      : providerRuntimeLabel(providerType);
  const activeType = state.integrations.find(
    (p) => p.id === state.engine.providerId,
  )?.providerType;
  const activeLabel =
    activeType === "compatible"
      ? t("Compatible endpoint")
      : providerRuntimeLabel(activeType);
  const [setupWorkspace, setSetupWorkspace] = useState(
    state.workspaces[0]?.id ?? "",
  );
  const [nativeSetup, setNativeSetup] = useState<NativeToolSetup | null>(null);
  const [models, setModels] = useState<Models>([]),
    [pending, setPending] = useState(false),
    [pendingLabel, setPendingLabel] = useState(
      "Contacting the selected provider…",
    ),
    [error, setError] = useState("");
  const mounted = useRef(true);
  const selected = models.find((m) => m.id === model);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (
    fn: () => Promise<void>,
    label = "Contacting the selected provider…",
  ) => {
    setPendingLabel(label);
    setPending(true);
    setError("");
    try {
      if (runOperation) await runOperation(fn, t(label));
      else await fn();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <article className="card engine-settings">
      <h2>{t("Inference engine")}</h2>
      <p>
        {t("Current mode:")}{" "}
        <strong>
          {state.engine.mode === "live"
            ? `${activeLabel} · ${state.engine.model}`
            : t("Explicit simulator")}
        </strong>
      </p>
      <p className="muted">
        {t(
          "Live mode uses an isolated Codex App Server and the selected provider. Configure an enabled provider in Models & accounts first. A workspace is required for live turns.",
        )}
      </p>
      <fieldset disabled={busy || pending || operationPending}>
        <label>
          {t("Engine provider")}
          <select
            aria-label={t("Engine provider")}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setModels([]);
              setModel("");
              setEffort("");
              setError("");
              setNativeSetup(null);
            }}
          >
            <option value="">{t("Select a provider")}</option>
            {state.integrations
              .filter((p) => p.kind === "provider" && p.enabled)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!provider}
          onClick={() =>
            void run(async () => {
              const result = value(await api.engineModels(provider));
              if (!mounted.current) return;
              setModels(result);
              const chosen =
                result.find((m) => m.id === model && !m.unavailableReason) ??
                result.find((m) => m.coreModel?.isDefault) ??
                result.find((m) => !m.unavailableReason);
              setModel(chosen?.id ?? "");
              setEffort(
                chosen?.reasoning_efforts.includes(effort)
                  ? effort
                  : (chosen?.default_reasoning_effort ?? ""),
              );
            })
          }
        >
          {t("Read live model catalog")}
        </button>
        <label>
          {t("Engine model")}
          <select
            aria-label={t("Engine model")}
            value={model}
            disabled={!models.length}
            onChange={(e) => {
              setModel(e.target.value);
              setEffort(
                models.find((m) => m.id === e.target.value)
                  ?.default_reasoning_effort ?? "",
              );
            }}
          >
            {!models.length && (
              <option value={model}>
                {model || t("Read the catalog first")}
              </option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!!m.unavailableReason}>
                {m.coreModel ? `${m.coreModel.displayName} · ${m.id}` : m.id}
                {m.unavailableReason ? ` · ${m.unavailableReason}` : ""}
              </option>
            ))}
          </select>
        </label>
        {openAi && selected && (
          <>
            <p className="muted">
              {selected.providerModel
                ? t(
                    "{context}: {tokens} tokens. Core manages this model's history and compaction; Axiom context/profile overrides do not apply.",
                    {
                      context:
                        providerType === "deepseek"
                          ? t("Conservative client context budget")
                          : t("Documented model context"),
                      tokens:
                        selected.context_window == null
                          ? t("not reported")
                          : number(selected.context_window),
                    },
                  )
                : t(
                    "Context managed by Core; model/list does not report a numeric window.",
                  )}{" "}
              {t("Catalog metadata does not prove inference availability.")}
            </p>
            <label>
              {t("Model reasoning effort")}
              <select
                aria-label={t("Model reasoning effort")}
                value={effort}
                disabled={!selected.reasoning_efforts.length}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">
                  {t("Provider default (no effort override)")}
                </option>
                {selected.reasoning_efforts.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted">
              {selected.coreModel?.description ??
                selected.providerModel?.description}
            </p>
          </>
        )}
        {!openAi && selected && (
          <p className="muted">
            {t("Advertised contexts:")}{" "}
            {models
              .find((m) => m.id === model)!
              .context_window_options.join(", ")}{" "}
            · {t("Profiles:")}{" "}
            {models.find((m) => m.id === model)!.reasoning_efforts.join(", ")}
          </p>
        )}
        <p className="muted" data-testid="native-tools-policy">
          {t(
            "App Server provides native tools in both direct and Tutor sessions. The selected permission mode applies to every tool call.",
          )}
        </p>
        {["darwin", "linux"].includes(servicePlatform ?? "") ? (
          <p className="muted" data-testid="native-tools-platform">
            {t(
              "No Windows sandbox setup is required on {platform}. This is not a tool-disable switch.",
              { platform: servicePlatform === "darwin" ? "macOS" : "Linux" },
            )}
          </p>
        ) : (
          <details className="native-tool-setup">
            <summary>{t("Native tool prerequisites")}</summary>
            <p className="muted">
              {t(
                "Windows file and command tools require Core's native sandbox setup. Checking status does not send a model request. Setup applies to this Synora provider's isolated Core state.",
              )}
            </p>
            <label>
              {t("Setup workspace")}
              <select
                aria-label={t("Setup workspace")}
                value={setupWorkspace}
                onChange={(e) => {
                  setSetupWorkspace(e.target.value);
                  setNativeSetup(null);
                }}
              >
                <option value="">{t("Choose a workspace")}</option>
                {state.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!provider || !setupWorkspace}
              onClick={() =>
                void run(async () => {
                  const result = value(
                    await api.engineNativeSetup(provider, setupWorkspace),
                  );
                  if (mounted.current) setNativeSetup(result);
                }, "Checking native prerequisites and preparing the verified Core runtime…")
              }
            >
              {t("Check native tool setup")}
            </button>
            {nativeSetup && (
              <p role="status">
                {nativeSetup.status === "notApplicable"
                  ? t(
                      "No Windows sandbox setup is required on {platform}. This is not a tool-disable switch.",
                      {
                        platform:
                          nativeSetup.platform === "darwin"
                            ? "macOS"
                            : nativeSetup.platform,
                      },
                    )
                  : t("Service host: {platform} · Native setup: {status}", {
                      platform: nativeSetup.platform,
                      status: nativeSetup.status,
                    })}
              </p>
            )}
            {nativeSetup?.platform === "win32" && (
              <>
                <p className="muted">
                  {t(
                    "Recommended administrator setup creates lower-privilege sandbox users and Windows firewall/policy rules. Restricted-token setup does not require administrator accounts, but provides weaker network isolation. Neither option disables sandboxing. Windows may require an interactive desktop session.",
                  )}
                </p>
                {state.engine.mode === "live" && (
                  <p className="muted">
                    {t(
                      "Select simulator mode before changing native setup. Your live history is retained.",
                    )}
                  </p>
                )}
                <div className="actions">
                  {(["elevated", "unelevated"] as const).map((mode) => (
                    <button
                      key={mode}
                      disabled={state.engine.mode === "live"}
                      onClick={() =>
                        void run(async () => {
                          const result = value(
                            await api.engineNativeSetup(
                              provider,
                              setupWorkspace,
                              mode,
                            ),
                          );
                          if (mounted.current) setNativeSetup(result);
                        }, "Preparing the Windows sandbox. Assigning permissions can take several minutes; keep Synora open…")
                      }
                    >
                      {mode === "elevated"
                        ? t("Set up administrator sandbox")
                        : t("Set up restricted-token sandbox")}
                    </button>
                  ))}
                </div>
              </>
            )}
          </details>
        )}
        <div className="actions">
          <button
            disabled={
              !model ||
              !models.some((m) => m.id === model && !m.unavailableReason)
            }
            onClick={() =>
              void run(async () => {
                const s = value(
                  await api.engineConfigure({
                    mode: "live",
                    providerId: provider,
                    model,
                    ...(openAi && effort ? { reasoningEffort: effort } : {}),
                  }),
                );
                await applied(s);
              })
            }
          >
            {t("Use live {provider}", { provider: label })}
          </button>
          <button
            disabled={state.engine.mode === "simulated"}
            onClick={() =>
              void run(async () => {
                const s = value(
                  await api.engineConfigure({
                    mode: "simulated",
                    providerId: null,
                    model: null,
                  }),
                );
                await applied(s);
              })
            }
          >
            {t("Use simulator")}
          </button>
        </div>
      </fieldset>
      {pending && <p role="status">{t(pendingLabel)}</p>}
      {busy && (
        <p className="muted">
          {t("Finish or cancel the active turn before changing engines.")}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {t("Error: {detail}", { detail: error })}
        </p>
      )}
    </article>
  );
}
