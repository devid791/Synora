import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/providers";
import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  DesktopAPI,
  EngineConfig,
  ModelCapabilities,
  Result,
} from "../shared/contracts";
import { providerUsesCoreModel } from "../shared/provider-registry";
import { Modal } from "./Modal";
const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
class ModelPickerNotice extends Error {}

export function WorkspaceModelPicker({
  api,
  state,
  busy,
  runOperation,
  apply,
  accounts,
}: {
  api: DesktopAPI;
  state: AppState;
  busy: boolean;
  runOperation: (fn: () => Promise<void>, label?: string) => Promise<void>;
  apply: (config: EngineConfig) => Promise<void>;
  accounts: () => void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const [open, setOpen] = useState(false),
    [provider, setProvider] = useState(state.engine.providerId ?? "");
  const [model, setModel] = useState(state.engine.model ?? ""),
    [effort, setEffort] = useState(state.engine.reasoningEffort ?? "");
  const [models, setModels] = useState<ModelCapabilities[]>([]),
    [error, setError] = useState("");
  const [errorKey, setErrorKey] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const configured = state.integrations.filter(
    (p) => p.kind === "provider" && p.enabled,
  );
  const chosenProvider = configured.find((p) => p.id === provider);
  const key = chosenProvider ? JSON.stringify(chosenProvider) : provider;
  const active = configured.find((p) => p.id === state.engine.providerId);
  const core = providerUsesCoreModel(chosenProvider?.providerType);
  const selected = models.find((m) => m.id === model);
  const read = async () => {
    setError("");
    setErrorKey("");
    try {
      await runOperation(async () => {
        let id = provider;
        if (id === "@openai-account") {
          const account = unwrap(await api.coreAccountRead());
          if (!account.account?.account)
            throw new ModelPickerNotice(
              "Connect your OpenAI / ChatGPT account in Models & accounts first.",
            );
          const latest = unwrap(await api.state());
          const p = latest.integrations.find(
            (p) =>
              p.kind === "provider" && p.providerType === "openai" && p.enabled,
          );
          if (!p)
            throw new ModelPickerNotice("Enable your OpenAI provider in Models & accounts.");
          id = p.id;
          if (mounted.current) setProvider(id);
        }
        const catalog = unwrap(await api.engineModels(id));
        if (!mounted.current) return;
        setModels(catalog);
        // Receipt is tied to the exact current configuration, never another provider.
        const config = unwrap(await api.state()).integrations.find(
          (p) => p.id === id,
        );
        setLoadedKey(config ? JSON.stringify(config) : "");
        const m =
          catalog.find((m) => m.id === model && !m.unavailableReason) ??
          catalog.find((m) => m.coreModel?.isDefault && !m.unavailableReason) ??
          catalog.find((m) => !m.unavailableReason);
        setModel(m?.id ?? "");
        setEffort(m?.id === model && m.reasoning_efforts.includes(effort)
          ? effort
          : m?.default_reasoning_effort ?? "");
      }, t("Reading the selected provider's model catalog…"));
    } catch (e) {
      if (mounted.current) {
        if (e instanceof ModelPickerNotice) setErrorKey(e.message);
        else setError(e instanceof Error ? e.message : String(e));
      }
    }
  };
  // Discover on opening/changing provider, not during a running turn and not in
  // a failure retry loop. Manual refresh remains available.
  const requested = useRef("");
  useEffect(() => {
    if (!open) {
      requested.current = "";
      return;
    }
    if (busy || !provider || requested.current === key) return;
    requested.current = key;
    if (key !== loadedKey) void read();
  }, [open, key, busy, loadedKey]);
  return (
    <section
      className="workspace-model-picker"
      aria-label={t("Workspace model selection")}
    >
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        {active?.name ?? t("Select provider")} ·{" "}
        {state.engine.model ?? t("Select model")} ▾
      </button>
      {open && (
        <Modal label={t("Choose provider and model")} onDismiss={() => setOpen(false)}>
        <div className="modal workspace-model-controls">
          <div className="actions"><h2>{t("Provider and model")}</h2><button type="button" onClick={() => setOpen(false)}>{t("Close")}</button></div>
          <fieldset disabled={busy}>
            <label>{t("Provider")}<select
                aria-label={t("Workspace provider")}
                value={provider}
                onChange={(e) => {
                  // Re-selecting the same native option must not erase a valid
                  // catalog while its request key remains unchanged.
                  if (e.target.value === provider) return;
                  setProvider(e.target.value);
                  setModels([]);
                  setLoadedKey("");
                  setModel("");
                  setEffort("");
                  setError("");
                  setErrorKey("");
                }}
              >
                <option value="">{t("Choose provider")}</option>
                {configured.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                {!configured.some((p) => p.providerType === "openai") && (
                  <option value="@openai-account">{t("OpenAI / ChatGPT account")}</option>
                )}
              </select>
            </label>
            <label>{t("Model")}<select
                aria-label={t("Workspace model")}
                value={model}
                disabled={!models.length || key !== loadedKey}
                onChange={(e) => {
                  setModel(e.target.value);
                  setEffort(
                    models.find((m) => m.id === e.target.value)
                      ?.default_reasoning_effort ?? "",
                  );
                }}
              >
                {!models.length && (
                  <option value={model}>{t("Read this provider's catalog")}</option>
                )}
                {models.map((m) => (
                  <option
                    key={m.id}
                    value={m.id}
                    disabled={!!m.unavailableReason}
                  >
                    {m.coreModel?.displayName ?? m.id}
                    {m.unavailableReason ? ` · ${m.unavailableReason}` : ""}
                  </option>
                ))}
              </select>
            </label>
            {core && (
              <label>{t("Reasoning")}<select
                  aria-label={t("Workspace model reasoning")}
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                >
                  <option value="">{t("Provider default")}</option>
                  {selected?.reasoning_efforts.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={!provider}
                onClick={() => void read()}
              >{t("Refresh models")}</button>
              <button
                type="button"
                disabled={
                  !selected || !!selected.unavailableReason || key !== loadedKey
                }
                onClick={() => {
                  void apply({
                    mode: "live",
                    providerId: provider,
                    model,
                    ...(core && effort ? { reasoningEffort: effort } : {}),
                  })
                    .then(() => setOpen(false))
                    .catch((e) =>
                      setError(e instanceof Error ? e.message : String(e)),
                    );
                }}
              >{t("Use model")}</button>
              <button type="button" onClick={() => { setOpen(false); accounts(); }}>{t("Add provider / accounts")}</button>
            </div>
          </fieldset>
          <p className="muted">{t("Switching provider or model starts a new conversation. Your current history and draft are preserved. Use Tutor mode → Set up tutor to assign this provider as tutor.")}</p>
          {(errorKey || error) && <p role="alert">{errorKey ? t(errorKey) : error}</p>}
        </div>
        </Modal>
      )}
    </section>
  );
}
