import { useI18n, type Messages } from "./i18n";
import { messages, signInStateKeys } from "./locales/providers";
import { useEffect, useState } from "react";
import type {
  AppState,
  DesktopAPI,
  McpAuthorization,
  Result,
} from "../shared/contracts";
import { oauthBrowserUrl } from "../shared/oauth-url";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
export function McpSignIn({
  api,
  state,
  busy,
  web,
}: {
  api: DesktopAPI;
  state: AppState;
  busy: boolean;
  web: boolean;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const integrations = state.integrations.filter(
    (v) => v.enabled && v.executor === "http-mcp" && v.auth === "oauth",
  );
  const providers = state.integrations.filter(
    (v) =>
      v.enabled &&
      v.kind === "provider" &&
      (v.auth === "none" || v.auth === "api-key" || v.auth === "core-account"),
  );
  const [integration, setIntegration] = useState(integrations[0]?.id ?? "");
  const [provider, setProvider] = useState(
    state.engine.providerId ?? providers[0]?.id ?? "",
  );
  const [flow, setFlow] = useState<McpAuthorization | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<{ key: string; detail?: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const active =
    !!flow?.busy ||
    flow?.status === "starting" ||
    flow?.status === "awaiting_browser";
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = value(await api.mcpAuthorizationStatus());
        if (stopped) return;
        setFlow(current);
        if (
          current?.status === "starting" ||
          current?.status === "awaiting_browser"
        ) {
          setIntegration(current.integrationId);
          setProvider(current.providerId);
        }
        if (
          (current?.busy && !current.cleanupFailed) ||
          current?.status === "starting" ||
          current?.status === "awaiting_browser"
        )
          timer = setTimeout(poll, 750);
      } catch (e) {
        if (!stopped)
          setError(
            { key: "Could not read sign-in status", detail: e instanceof Error ? e.message : undefined },
          );
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, refresh]);
  if (!integrations.length && !flow) return null;
  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError({ key: "Sign-in operation failed", detail: e instanceof Error ? e.message : undefined });
    } finally {
      setPending(false);
      setRefresh((v) => v + 1);
    }
  };
  let href: string | undefined;
  if (flow?.status === "awaiting_browser" && flow.authorizationUrl)
    try {
      href = oauthBrowserUrl(flow.authorizationUrl);
    } catch {
      /* No unsafe link. */
    }
  return (
    <article className="card engine-settings" aria-label={t("MCP browser sign-in")}>
      <h2>{t("MCP browser sign-in")}</h2>
      <p>{t("App Server owns OAuth, token exchange and refresh. Select the same provider used by your live session. No model request is made.")}</p>
      <fieldset disabled={busy || pending || active}>
        <label>{t("MCP integration")}<select
            aria-label={t("OAuth MCP integration")}
            value={integration}
            onChange={(e) => setIntegration(e.target.value)}
          >
            <option value="">{t("Choose an integration")}</option>
            {integrations.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label>{t("Synora provider namespace")}<select
            aria-label={t("OAuth provider namespace")}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">{t("Choose a provider")}</option>
            {providers.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={
            !integrations.some((v) => v.id === integration) ||
            !providers.some((v) => v.id === provider)
          }
          onClick={() =>
            void run(async () => {
              setFlow(value(await api.mcpAuthorize(integration, provider)));
            })
          }
        >{t("Start browser sign-in")}</button>
      </fieldset>
      <p className="muted">{t("Tokens stay in this Synora provider’s private Core directory, not in another Codex application or your exported configuration. They are stored in a local credentials file readable by your OS account.")}</p>
      {web && (
        <p>{t("Use a browser on the Synora service host for the local OAuth callback. Remote web deployment requires a separately configured callback.")}</p>
      )}
      {flow && (
        <div role="status" aria-live="polite">
          <p>
            <strong>
              {flow.status === "authorized"
                ? t("Browser sign-in completed")
                : t(signInStateKeys[flow.status])}
            </strong>{" "}
            · {flow.integrationId} · {flow.providerId}
          </p>
          {flow.message && <p>{flow.message}</p>}
          {flow.status === "authorized" && (
            <p>{t("This confirms the original Core login event, not current tool availability. Start or resume a live session to verify the connected catalog.")}</p>
          )}
          {flow.status === "awaiting_browser" &&
            href &&
            (web ? (
              <a
                className="button"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >{t("Open authorization page")}</a>
            ) : (
              <button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    value(await api.mcpAuthorizationOpen(flow.id));
                  })
                }
              >{t("Open authorization page")}</button>
            ))}
          {active && !flow.cleanupFailed && (
            <button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  setFlow(value(await api.mcpAuthorizationCancel(flow.id)));
                })
              }
            >{t("Cancel sign-in")}</button>
          )}
        </div>
      )}
      {pending && <p role="status">{t("Applying sign-in operation…")}</p>}
      {error && (
        <div role="alert">
          <p>{t(error.key)}{error.detail ? `: ${error.detail}` : ""}</p>
          <button
            disabled={pending}
            onClick={() => {
              setError(null);
              setRefresh((v) => v + 1);
            }}
          >{t("Refresh sign-in status")}</button>
        </div>
      )}
    </article>
  );
}
