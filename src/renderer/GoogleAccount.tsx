import { useI18n, type Messages } from "./i18n";
import { messages, signInStateKeys } from "./locales/providers";
import { useEffect, useState } from "react";
import type { DesktopAPI, Integration, Result } from "../shared/contracts";
import type { GoogleAccountStatus } from "../shared/google-oauth";
import type { ProviderLoginStatus } from "../shared/provider-login";
import { oauthBrowserUrl } from "../shared/oauth-url";
const value = <T,>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
export function GoogleAccount({
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
  const [account, setAccount] = useState<GoogleAccountStatus | null>(null);
  const [login, setLogin] = useState<ProviderLoginStatus | null>(null);
  const [clientId, setClientId] = useState(""),
    [quotaProject, setProject] = useState("");
  const [clientSecret, setSecret] = useState(""),
    [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [pending, setPending] = useState(false),
    [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false),
    [readError, setReadError] = useState<{ key: string; detail?: string } | null>(null);
  useEffect(() => {
    let stopped = false,
      fetching = false,
      lastGrant = "",
      initialized = false;
    const read = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [a, l] = await Promise.all([
          api.googleAccountStatus(provider.id),
          api.googleLoginStatus(),
        ]);
        if (stopped) return;
        const next = value(a),
          auth = value(l);
        setAccount(next);
        setLogin(auth);
        setReadError(null);
        if (!initialized) {
          initialized = true;
          setClientId(next.clientId ?? "");
          setProject(next.quotaProject ?? "");
        }
        if (
          auth?.providerId === provider.id &&
          auth.status === "authorized" &&
          lastGrant !== auth.id
        ) {
          lastGrant = auth.id;
          onAuthorized();
        }
      } catch (e) {
        if (!stopped) {
          setAccount(null);
          setReadError(
            { key: "Google status unavailable", detail: e instanceof Error ? e.message : undefined },
          );
        }
      } finally {
        fetching = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, provider.id, provider.endpoint, onAuthorized]);
  const active =
    login?.status === "awaiting_authorization" ||
    login?.status === "exchanging";
  const mine = login?.providerId === provider.id ? login : null;
  const locked = busy || pending || active;
  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ key: "Google authorization failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      setPending(false);
      setSecret("");
    }
  };
  const url = mine?.authorizationUrl
    ? oauthBrowserUrl(mine.authorizationUrl)
    : null;
  return (
    <section
      className="engine-settings"
      aria-label={t("Google browser sign-in for {provider}", { provider: provider.name })}
    >
      <h3>{t("Google / Gemini browser sign-in")}</h3>
      <p>{t("Use a Google OAuth Desktop client registered for Synora and a quota project with the Generative Language API enabled. This authorizes Google Cloud API access; it does not use your consumer Gemini subscription. Project quotas and billing apply.")}</p>
      <p>{t("The browser must return to the computer running Synora's local service. For a remote service, forward its displayed loopback callback port first. Google does not support a manual paste-code return for this Desktop flow.")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            setAccount(
              value(
                await api.googleAccountConfigure(provider.id, {
                  clientId,
                  quotaProject,
                  ...(clientSecret ? { clientSecret } : {}),
                }),
              ),
            );
          });
        }}
      >
        <fieldset disabled={locked || !account || account.authorized}>
          <label>{t("Google Desktop client ID")}<input
              aria-label={t("Google Desktop client ID")}
              value={clientId}
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setClientId(e.target.value)}
              required
            />
          </label>
          <label>{t("Google client secret (if issued)")}<input
              aria-label={t("Google client secret")}
              value={clientSecret}
              type="password"
              maxLength={4096}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setSecret(e.target.value)}
            />
          </label>
          <label>{t("Google quota project")}<input
              aria-label={t("Google quota project")}
              value={quotaProject}
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setProject(e.target.value)}
              required
            />
          </label>
          <p>{t("When replacing client configuration, reenter its client secret if Google issued one. Saved secrets are never shown here.")}</p>
          <button disabled={!clientId || !quotaProject}>{t("Save Google OAuth client")}</button>
        </fieldset>
      </form>
      <p role="status">
        {account
          ? account.authorized
            ? t("Google authorization saved · access tokens refresh automatically")
            : account.needsLogin
              ? t("Google authorization expired or revoked · sign in again")
              : account.configured
                ? t("OAuth client configured · sign-in required")
                : t("OAuth client not configured")
          : t("Reading Google account status…")}
      </p>
      <p>
        {account?.storage === "os-encrypted"
          ? t("Credentials encrypted by the OS credential service.")
          : t("Credentials use a private local file; not encrypted at rest on this host.")}{" "}{t("Tokens and client secrets are never exported with configuration.")}</p>
      {account?.quotaProject && <p>{t("Quota project: {project}", { project: account.quotaProject })}</p>}
      <button
        disabled={locked || !provider.enabled || !account?.configured}
        onClick={() =>
          void run(async () => {
            const next = value(await api.googleLoginStart(provider.id));
            setLogin(next);
            if (!web) value(await api.googleLoginOpen(next.id));
          })
        }
      >{t("Sign in with Google")}</button>
      {mine && (
        <p role="status">{t("Authorization: {status}", { status: t(signInStateKeys[mine.status]) })}</p>
      )}
      {url && (
        <>
          <p>
            <a href={url} target="_blank" rel="noopener noreferrer">{t("Open Google authorization")}</a>
          </p>
          <p className="mono">{t("Callback: {url}", { url: new URL(url).searchParams.get("redirect_uri") ?? "" })}
          </p>
        </>
      )}
      {mine && active && (
        <button
          disabled={pending}
          onClick={() =>
            void run(async () => {
              setLogin(value(await api.googleLoginCancel(mine.id)));
            })
          }
        >{t("Cancel Google sign-in")}</button>
      )}
      {(account?.authorized || account?.needsLogin) && (
        <>
          <button
            disabled={locked}
            onClick={() =>
              void run(async () => {
                setAccount(
                  value(await api.googleAccountDisconnect(provider.id, false)),
                );
                onAuthorized();
              })
            }
          >{t("Disconnect Google locally")}</button>
          <label className="check">
            <input
              type="checkbox"
              checked={confirmRevoke}
              disabled={locked}
              onChange={(e) => setConfirmRevoke(e.target.checked)}
            />{t("I understand revocation can remove all Google OAuth grants for this project, including other clients.")}</label>
          <button
            disabled={locked || !confirmRevoke}
            onClick={() =>
              void run(async () => {
                setAccount(
                  value(await api.googleAccountDisconnect(provider.id, true)),
                );
                setConfirmRevoke(false);
                onAuthorized();
              })
            }
          >{t("Revoke Google access")}</button>
        </>
      )}
      {mine?.error && <p role="alert">{mine.error}</p>}
      {(account?.configured || readError) && (
        <>
          <label className="check">
            <input
              type="checkbox"
              aria-label={t("Confirm local Google configuration removal")}
              checked={confirmForget}
              disabled={locked}
              onChange={(e) => setConfirmForget(e.target.checked)}
            />{t("Remove this provider's saved OAuth client and local tokens. This does not revoke access at Google.")}</label>
          <button
            disabled={locked || !confirmForget}
            onClick={() =>
              void run(async () => {
                setAccount(
                  value(await api.googleAccountForget(provider.id, true)),
                );
                setConfirmForget(false);
                setClientId("");
                setProject("");
                setLogin(null);
                setReadError(null);
                onAuthorized();
              })
            }
          >{t("Remove Google OAuth configuration")}</button>
        </>
      )}
      {readError && <p role="alert">{t(readError.key)}{readError.detail ? `: ${readError.detail}` : ""}</p>}
      {error && <p role="alert">{t(error.key)}{error.detail ? `: ${error.detail}` : ""}</p>}
    </section>
  );
}
