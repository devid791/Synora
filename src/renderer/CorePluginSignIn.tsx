import { useEffect, useRef, useState } from "react";
import type { DesktopAPI, McpAuthorization, Result } from "../shared/contracts";
import type { CorePluginSnapshot } from "../shared/core-plugin";
import { oauthBrowserUrl } from "../shared/oauth-url";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
export function CorePluginSignIn({
  api,
  plugin,
  disabled,
  onBusy,
}: {
  api: DesktopAPI;
  plugin: CorePluginSnapshot;
  disabled: boolean;
  onBusy: (v: boolean) => void;
}) {
  const { t } = useI18n(messages);
  const [flow, setFlow] = useState<McpAuthorization | null>(null),
    [error, setError] = useState<string | { key: string }>(""),
    [pending, setPending] = useState(false),
    [refresh, setRefresh] = useState(0),
    [web, setWeb] = useState<boolean>();
  const mounted = useRef(true),
    busyCallback = useRef(onBusy);
  busyCallback.current = onBusy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyCallback.current(false);
    };
  }, []);
  const active =
    !!flow?.busy ||
    flow?.status === "starting" ||
    flow?.status === "awaiting_browser";
  useEffect(() => {
    busyCallback.current(pending || active);
  }, [pending, active]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    void api
      .capabilities()
      .then((r) => {
        if (!stopped) setWeb(value(r).transport === "local-http");
      })
      .catch((e) => {
        if (!stopped) setError(e.message);
      });
    const poll = async () => {
      try {
        const current = value(await api.mcpAuthorizationStatus());
        if (stopped) return;
        setFlow(current);
        if (
          pending ||
          (current?.busy && !current.cleanupFailed) ||
          current?.status === "starting" ||
          current?.status === "awaiting_browser"
        )
          timer = setTimeout(poll, 500);
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : { key: "Cannot read sign-in status" },
          );
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, pending, refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : { key: "Sign-in failed" });
    } finally {
      if (mounted.current) {
        setPending(false);
        setRefresh((n) => n + 1);
      }
    }
  };
  const matching =
    flow?.pluginId === plugin.target.pluginId &&
    flow.providerId === plugin.target.providerId;
  let href: string | undefined;
  if (matching && flow?.status === "awaiting_browser" && flow.authorizationUrl)
    try {
      href = oauthBrowserUrl(flow.authorizationUrl);
    } catch {
      /* No unsafe link. */
    }
  return (
    <section aria-label={t("Plugin MCP browser sign-in")}>
      <h3>{t("Plugin MCP browser sign-in")}</h3>
      <p>
        {t("Sign in explicitly to a declared server. Core owns token exchange and private storage. A successful login is not a tool-execution test.")}
      </p>
      {plugin.detail?.mcpServers.map((name) => (
        <button
          key={name}
          disabled={
            disabled ||
            pending ||
            active ||
            !plugin.detail?.summary.installed ||
            !plugin.detail.summary.enabled ||
            plugin.phase !== "completed"
          }
          onClick={() =>
            void run(async () => {
              value(await api.corePluginAuthorize(plugin.id, name));
            })
          }
        >
          {t("Sign in to {name}", { name })}
        </button>
      ))}
      {active && !matching && (
        <p role="status">
          {t("Another MCP sign-in is active. Complete or cancel it in MCP browser sign-in.")}
        </p>
      )}
      {matching && flow && (
        <div role="status">
          <p>
            {flow.status === "authorized"
              ? t("Plugin browser sign-in completed")
              : t("Sign-in status: {status}", { status: flow.status })}{" "}
            · {flow.serverName}
          </p>
          {flow.message && <p>{t(flow.message)}</p>}
          {href &&
            (web === true ? (
              <a
                className="button"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("Open plugin authorization page")}
              </a>
            ) : web === false ? (
              <button
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    value(await api.mcpAuthorizationOpen(flow.id));
                  })
                }
              >
                {t("Open plugin authorization page")}
              </button>
            ) : (
              <p>{t("Reading browser capabilities…")}</p>
            ))}
          {active && !flow.cleanupFailed && (
            <button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  value(await api.mcpAuthorizationCancel(flow.id));
                })
              }
            >
              {t("Cancel plugin sign-in")}
            </button>
          )}
        </div>
      )}
      {web && (
        <p>
          {t("The OAuth callback is on the Synora service host. Use its local browser; remote web deployment needs a configured callback.")}
        </p>
      )}
      {error && <p role="alert">{typeof error === "string" ? t("Error: {detail}", { detail: error }) : t(error.key)}</p>}
      <button
        disabled={pending}
        onClick={() => {
          setError("");
          setRefresh((n) => n + 1);
        }}
      >
        {t("Refresh plugin sign-in status")}
      </button>
    </section>
  );
}
