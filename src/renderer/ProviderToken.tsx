import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/providers";
import { useEffect, useState } from "react";
import type {
  DesktopAPI,
  Integration,
  ProviderCredentialStatus,
  Result,
} from "../shared/contracts";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
export function ProviderToken({
  api,
  provider,
  busy,
  refreshAfter,
}: {
  api: DesktopAPI;
  provider: Integration;
  busy: boolean;
  refreshAfter?: number;
}) {
  const { t, number } = useI18n(messages satisfies Messages);
  const credentialLabel = ["gemini", "deepseek", "mistral"].includes(
    provider.providerType ?? "",
  )
    ? t("API key")
    : t("Bearer token");
  const [status, setStatus] = useState<ProviderCredentialStatus | null>(null),
    [token, setToken] = useState("");
  const [pending, setPending] = useState(false),
    [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [notice, setNotice] = useState<"saved" | "removed" | number | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    setStatus(null);
    setError(null);
    setToken("");
    setNotice(null);
    void api
      .providerCredentialStatus(provider.id)
      .then(value)
      .then((v) => {
        if (!stopped) setStatus(v);
      })
      .catch((e) => {
        if (!stopped)
          setError(
            { key: "Credential status unavailable", detail: e instanceof Error ? e.message : undefined },
          );
      });
    return () => {
      stopped = true;
    };
  }, [api, provider.id, provider.endpoint, revision, refreshAfter]);
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError({ key: "Credential operation failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      setToken("");
      setPending(false);
    }
  };
  return (
    <section
      className="provider-token engine-settings"
      aria-label={t("{credential} for {provider}", { credential: credentialLabel, provider: provider.name })}
    >
      <h3>
        {provider.providerType === "xai"
          ? t("xAI API key")
          : provider.providerType === "openrouter"
            ? t("OpenRouter API key")
            : provider.providerType === "deepseek"
              ? t("DeepSeek API key")
              : provider.providerType === "mistral"
                ? t("Mistral API key")
                : provider.providerType === "compatible"
                  ? t("Compatible endpoint Bearer token")
                  : provider.providerType === "gemini"
                    ? t("Gemini API key")
                    : provider.providerType === "anthropic"
                      ? t("Anthropic API credential")
                      : t("Axiom Bearer token")}
      </h3>
      {provider.providerType === "gemini" && (
        <p>{t("Use your own Gemini API key. Google browser login requires a Synora-owned OAuth client and project; select Google browser login in the provider's authentication settings to configure it.")}</p>
      )}
      {provider.providerType === "anthropic" && (
        <p>{t("Use your own Claude API credential. Claude consumer or Claude Code browser sessions are not an API grant for Synora; no browser grant is configured for this adapter.")}</p>
      )}
      <p>
        {status
          ? status.present
            ? status.usable
              ? t("Token saved for this endpoint")
              : t("Saved token is unavailable to this OS account")
            : t("No token saved for this endpoint")
          : t("Reading credential status…")}
      </p>
      <p className="muted">
        {status?.storage === "os-encrypted"
          ? t("Encrypted using the operating system credential service.")
          : t("Local private credential file, readable by your OS account; not encrypted at rest on this host.")}{" "}{t("Never included in exported configuration. Sent only to this exact endpoint over HTTPS (or loopback for local use).")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setStatus(
              value(await api.providerCredentialSave(provider.id, token)),
            );
            setNotice("saved");
          });
        }}
      >
        <fieldset disabled={busy || pending || !status}>
          <label>
            {credentialLabel}
            <input
              type="password"
              aria-label={t("{credential} for {provider}", { credential: credentialLabel, provider: provider.name })}
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                status?.present
                  ? t("Enter a replacement token")
                  : provider.providerType === "gemini"
                    ? t("Enter your Gemini API key")
                    : t("Enter token without Bearer prefix")
              }
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <div className="actions">
            <button type="submit" disabled={!token.trim()}>
              {status?.present ? t("Replace token") : t("Save token")}
            </button>
            <button
              type="button"
              disabled={!status?.present}
              onClick={() =>
                void run(async () => {
                  setStatus(
                    value(await api.providerCredentialDelete(provider.id)),
                  );
                  setNotice("removed");
                })
              }
            >{t("Remove token")}</button>
            <button
              type="button"
              disabled={!status?.usable || !provider.enabled}
              onClick={() =>
                void run(async () => {
                  const models = value(await api.engineModels(provider.id));
                  setNotice(models.length);
                })
              }
            >{t("Verify access")}</button>
          </div>
        </fieldset>
      </form>
      {pending && <p role="status">{t("Applying credential operation…")}</p>}
      {notice !== null && <p role="status">{notice === "saved"
        ? t("{credential} saved. Verify the model catalog to check access.", { credential: credentialLabel })
        : notice === "removed"
          ? t("Token removed from Synora. Server-side revocation is separate.")
          : t("Authenticated model catalog received: {count} model(s). No inference started.", { count: number(notice) })}</p>}
      {error && (
        <div role="alert">
          <p>{t(error.key)}{error.detail ? `: ${error.detail}` : ""}</p>
          <button disabled={pending} onClick={() => setRevision((v) => v + 1)}>{t("Reload credential status")}</button>
        </div>
      )}
    </section>
  );
}
