import { useI18n, type Messages } from "./i18n";
import { messages, signInStateKeys } from "./locales/providers";
import { useEffect, useState } from "react";
import type { DesktopAPI, Integration, Result } from "../shared/contracts";
import type { ProviderLoginStatus } from "../shared/provider-login";
import { providerDefinitions } from "../shared/provider-registry";
import { oauthBrowserUrl } from "../shared/oauth-url";
const value = <T,>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
export function ProviderLogin({
  api,
  provider,
  busy,
  web,
  onAuthorized,
}: {
  api: DesktopAPI;
  provider: Integration;
  busy: boolean;
  web: boolean;
  onAuthorized(): void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null),
    [loaded, setLoaded] = useState(false);
  const [method, setMethod] = useState<"browser" | "paste-code">(
    web ? "paste-code" : "browser",
  );
  const [code, setCode] = useState(""),
    [error, setError] = useState<{ key: string; detail?: string } | null>(null),
    [pending, setPending] = useState(false);
  useEffect(() => {
    let stopped = false,
      lastAuthorized = "";
    const poll = async () => {
      try {
        const next = value(await api.providerLoginStatus());
        if (stopped) return;
        setLogin(next);
        setLoaded(true);
        if (
          next?.providerId === provider.id &&
          next.status === "authorized" &&
          lastAuthorized !== next.id
        ) {
          lastAuthorized = next.id;
          onAuthorized();
        }
      } catch (e) {
        if (!stopped) {
          setError({ key: "Authorization failed", detail: String(e) });
          setLoaded(true);
        }
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, provider.id, onAuthorized]);
  const mine = login?.providerId === provider.id ? login : null;
  const active =
    login?.status === "awaiting_authorization" ||
    login?.status === "exchanging";
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError({ key: "Authorization failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      setCode("");
      setPending(false);
    }
  };
  const url = mine?.authorizationUrl
    ? oauthBrowserUrl(mine.authorizationUrl)
    : undefined;
  const allowed =
    provider.enabled &&
    provider.endpoint.replace(/\/$/, "") ===
      providerDefinitions.openrouter.endpoint;
  return (
    <section
      className="engine-settings"
      aria-label={t("Browser sign-in for {provider}", { provider: provider.name })}
    >
      <h3>{t("OpenRouter browser sign-in")}</h3>
      <p>{t("Authorize your own account in an external browser. OpenRouter issues an API key stored with the same endpoint protection as a manually entered key.")}</p>
      {!allowed && (
        <p>{t("Enable the official OpenRouter endpoint to use browser sign-in.")}</p>
      )}
      <label>{t("Authorization return method")}<select
          aria-label={t("Authorization return method")}
          value={method}
          disabled={busy || pending || active}
          onChange={(e) => setMethod(e.target.value as typeof method)}
        >
          <option value="browser">{t("Return to this computer")}</option>
          <option value="paste-code">{t("Paste code (web, VPN or SSH)")}</option>
        </select>
      </label>
      <button
        disabled={!loaded || !allowed || busy || pending || active}
        onClick={() =>
          void run(async () => {
            const next = value(
              await api.providerLoginStart(provider.id, method),
            );
            setLogin(next);
            if (!web) value(await api.providerLoginOpen(next.id));
          })
        }
      >{t("Sign in with browser")}</button>
      {mine && (
        <p role="status">{t("Authorization: {status}", { status: t(signInStateKeys[mine.status]) })}</p>
      )}
      {url && (
        <p>
          <a href={url} target="_blank" rel="noopener noreferrer">{t("Open OpenRouter authorization")}</a>
        </p>
      )}
      {mine?.status === "awaiting_authorization" &&
        mine.method === "paste-code" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                setLogin(value(await api.providerLoginSubmit(mine.id, code)));
              });
            }}
          >
            <label>{t("Authorization code")}<input
                aria-label={t("Authorization code")}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={code}
                maxLength={8192}
                onChange={(e) => setCode(e.target.value)}
                disabled={pending}
              />
            </label>
            <button disabled={pending || !code}>{t("Complete sign-in")}</button>
          </form>
        )}
      {mine && active && (
        <button
          onClick={() =>
            void run(async () => {
              setLogin(value(await api.providerLoginCancel(mine.id)));
            })
          }
        >{t("Cancel provider sign-in")}</button>
      )}
      {mine?.error && <p role="alert">{mine.error}</p>}
      {error && <p role="alert">{t(error.key)}{error.detail ? `: ${error.detail}` : ""}</p>}
    </section>
  );
}
