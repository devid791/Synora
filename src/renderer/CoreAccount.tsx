import { useI18n, type Messages } from "./i18n";
import { messages, signInStateKeys } from "./locales/providers";
import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, Result } from "../shared/contracts";
import {
  openAiAuthorizationUrl,
  type AccountLogin,
  type CoreAccountStatus,
} from "../shared/core-account";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

export function CoreAccount({
  api,
  busy,
  web,
}: {
  api: DesktopAPI;
  busy: boolean;
  web: boolean;
}) {
  const { t, locale } = useI18n(messages satisfies Messages);
  const [state, setState] = useState<CoreAccountStatus | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [mode, setMode] = useState<AccountLogin["type"]>("chatgpt"),
    [key, setKey] = useState("");
  const [refresh, setRefresh] = useState(0);
  const inspected = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        let result = value(await api.coreAccountStatus());
        if (!busy && !result.busy && !result.observedAt && !inspected.current) {
          inspected.current = true;
          result = value(await api.coreAccountRead());
        }
        if (stopped) return;
        setState(result);
        if (result.busy && !result.cleanupError) timer = setTimeout(poll, 500);
      } catch (e) {
        if (!stopped)
          setError(
            { key: "Could not read account operation", detail: e instanceof Error ? e.message : undefined },
          );
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, refresh, busy]);
  const run = async (action: () => Promise<CoreAccountStatus | void>) => {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (mounted.current && result) setState(result);
    } catch (e) {
      if (mounted.current)
        setError({ key: "Account operation failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      if (mounted.current) {
        setPending(false);
        setRefresh((v) => v + 1);
      }
    }
  };
  const active = state?.busy ?? false,
    attempt = state?.attempt,
    account = state?.account?.account;
  let href: string | undefined;
  if (
    active &&
    attempt?.authorizationUrl &&
    ["awaiting_browser", "awaiting_device"].includes(attempt.status)
  ) {
    try {
      href = openAiAuthorizationUrl(attempt.authorizationUrl);
    } catch {
      /* no untrusted browser target */
    }
  }
  return (
    <article
      className="card engine-settings provider-token"
      aria-label={t("OpenAI account")}
    >
      <h2>{t("OpenAI / ChatGPT account")}</h2>
      <p>{t("Original App Server sign-in, isolated to Synora. Reading or connecting an account does not send a model request or switch your inference engine.")}</p>
      <p role="status" aria-live="polite">
        {!state?.account
          ? t("Account status not checked")
          : !account
            ? t("Not signed in")
            : account.type === "chatgpt"
              ? `ChatGPT · ${account.email ?? t("No email reported")} · ${account.planType}`
              : account.type === "apiKey"
                ? t("API key saved · inference access not verified")
                : t("Amazon Bedrock account reported by Core")}
      </p>
      {state?.observedAt && (
        <p className="muted">{t("Account checked {date}. This does not verify model availability, billing or inference.", { date: new Date(state.observedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale) })}</p>
      )}
      <fieldset disabled={busy || pending || active}>
        <label>{t("Sign-in method")}<select
            aria-label={t("OpenAI sign-in method")}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as AccountLogin["type"]);
              setKey("");
            }}
          >
            <option value="chatgpt">{t("ChatGPT · external browser")}</option>
            <option value="chatgptDeviceCode">{t("ChatGPT · device code")}</option>
            <option value="apiKey">{t("OpenAI API key")}</option>
          </select>
        </label>
        {mode === "apiKey" && (
          <label>{t("OpenAI API key")}<input
              aria-label={t("OpenAI API key")}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              maxLength={16384}
            />
          </label>
        )}
        <div className="actions">
          <button
            onClick={() => void run(() => api.coreAccountRead().then(value))}
          >{t("Refresh OpenAI account")}</button>
          <button
            disabled={mode === "apiKey" && !key.trim()}
            onClick={() => {
              const login: AccountLogin =
                mode === "apiKey"
                  ? { type: mode, apiKey: key }
                  : { type: mode };
              setKey("");
              void run(() => api.coreAccountLogin(login).then(value));
            }}
          >
            {mode === "apiKey" ? t("Save OpenAI API key") : t("Start OpenAI sign-in")}
          </button>
          <button
            disabled={!account}
            onClick={() => void run(() => api.coreAccountLogout().then(value))}
          >{t("Sign out of Synora account")}</button>
        </div>
      </fieldset>
      <p className="muted">{t("Core owns token exchange, storage and refresh in Synora’s private credentials directory. The local credentials file is readable by your OS account; no key or token is included in exported configuration. Other Codex applications are not signed out.")}</p>
      {web && (
        <p>{t("Browser sign-in needs the local callback on the Synora service host. Choose device code if your browser is on a different machine.")}</p>
      )}
      {attempt && (
        <div role="status" aria-live="polite">
          <p>
            <strong>
              {attempt.status === "authorized"
                ? t("Core sign-in completed")
                : t(signInStateKeys[attempt.status])}
            </strong>
          </p>
          {attempt.message && <p>{attempt.message}</p>}
          {attempt.code && <p className="mono">{attempt.code}</p>}
          {attempt.userCode && (
            <p>{t("Enter this device code:")}{" "}<code>{attempt.userCode}</code>
            </p>
          )}
          {href &&
            (web ? (
              <a
                className="button"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >{t("Open OpenAI authorization page")}</a>
            ) : (
              <button
                disabled={pending}
                onClick={() =>
                  void run(() => api.coreAccountOpen(attempt.id).then(value))
                }
              >{t("Open OpenAI authorization page")}</button>
            ))}
          {active && !state?.cleanupError && (
            <button
              disabled={pending}
              onClick={() =>
                void run(() => api.coreAccountCancel(attempt.id).then(value))
              }
            >{t("Cancel OpenAI sign-in")}</button>
          )}
        </div>
      )}
      {pending && <p role="status">{t("Applying account operation…")}</p>}
      {state?.cleanupError && <p role="alert">{state.cleanupError}</p>}
      {error && (
        <div role="alert">
          <p>{t(error.key)}{error.detail ? `: ${error.detail}` : ""}</p>
          <button
            disabled={pending}
            onClick={() => {
              setError(null);
              setRefresh((v) => v + 1);
            }}
          >{t("Refresh account operation")}</button>
        </div>
      )}
    </article>
  );
}
