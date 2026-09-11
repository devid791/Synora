import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";
import { CorePluginSignIn } from "./CorePluginSignIn";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
import type { DesktopAPI, Result } from "../shared/contracts";
import {
  pluginChangeReason,
  type CorePluginSnapshot,
  type PluginAction,
} from "../shared/core-plugin";
export type PluginSelection = {
  catalogId: string;
  marketplace: string;
  pluginId: string;
  serial: number;
};
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
export function CorePluginPanel({
  api,
  request,
  onBusy,
  onChanged,
}: {
  api: DesktopAPI;
  request: PluginSelection | null;
  onBusy: (v: boolean) => void;
  onChanged: () => void;
}) {
  const { t, number } = useI18n(messages);
  const [flow, setFlow] = useState<CorePluginSnapshot | null>(null),
    [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | { key: string }>(""),
    [confirmed, setConfirmed] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [signInBusy, setSignInBusy] = useState(false);
  const [observedAuthBusy, setObservedAuthBusy] = useState(false);
  const mounted = useRef(true),
    busyCallback = useRef(onBusy),
    changeCallback = useRef(onChanged),
    restored = useRef(false);
  busyCallback.current = onBusy;
  changeCallback.current = onChanged;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    busyCallback.current(
      pending || !!flow?.busy || signInBusy || observedAuthBusy,
    );
  }, [pending, flow?.busy, signInBusy, observedAuthBusy]);
  useEffect(() => {
    setConfirmed(false);
  }, [flow?.id]);
  const run = async (
    action: () => Promise<CorePluginSnapshot | null>,
    mutation = false,
  ) => {
    setPending(true);
    setOpen(true);
    setError("");
    setRefresh((n) => n + 1);
    try {
      const result = await action();
      if (!mounted.current) return;
      setFlow(result);
      if (mutation && result?.mutationSent) changeCallback.current();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : { key: "Plugin operation failed" });
    } finally {
      if (mounted.current) {
        setPending(false);
        setRefresh((n) => n + 1);
      }
    }
  };
  useEffect(() => {
    if (request)
      void run(async () =>
        value(
          await api.corePluginInspect(
            request.catalogId,
            request.marketplace,
            request.pluginId,
          ),
        ),
      );
  }, [api, request]);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const current = value(await api.corePluginStatus());
        const auth = value(await api.mcpAuthorizationStatus());
        if (stopped) return;
        setFlow(current);
        const authBusy =
          !!auth?.busy ||
          auth?.status === "starting" ||
          auth?.status === "awaiting_browser";
        setObservedAuthBusy(authBusy);
        if (!restored.current && current?.busy) setOpen(true);
        restored.current = true;
        if (pending || current?.busy || (authBusy && !auth?.cleanupFailed))
          timer = setTimeout(read, 500);
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : { key: "Cannot read plugin status" },
          );
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, pending, refresh, signInBusy]);
  const changing = pending || !!flow?.busy || signInBusy || observedAuthBusy;
  const operating = pending || !!flow?.busy;
  const change = (action: PluginAction) => {
    if (flow)
      void run(
        async () => value(await api.corePluginChange(flow.id, action, true)),
        true,
      );
  };
  const detail = flow?.detail;
  const installReason = flow?.target.discoveryOnly
    ? "Connection required: this public plugin is not in the selected profile's account catalog. Connect its required account and refresh; installation does not grant access."
    : detail
      ? pluginChangeReason(detail, "install")
      : "Inspect this plugin first.";
  const uninstallReason = detail
    ? pluginChangeReason(detail, "uninstall")
    : "Inspect this plugin first.";
  return (
    <>
      {(flow || error) && (
        <button onClick={() => setOpen(true)}>
          {operating
            ? t("View running plugin operation")
            : t("View last plugin operation")}
        </button>
      )}
      {open && (
        <Modal label={t("Core plugin management")} onDismiss={() => setOpen(false)}>
          <section className="modal core-plugin-panel">
            <h2>
              {detail?.summary.interface?.displayName ??
                flow?.target.pluginName ??
                t("Inspecting plugin")}
            </h2>
            <p>
              {t("Original Core plugin management · isolated Synora provider profile. Upstream plugin APIs are under development.")}
            </p>
            {flow && (
              <p className="mono">
                {flow.target.pluginId} · {flow.target.marketplaceName} ·
                {t("provider {provider}", { provider: flow.target.providerId })}
              </p>
            )}
            {flow?.target.discoveryOnly && (
              <p role="status">
                {t("Connection required. This plugin is visible before sign-in, but its account-backed tools are not yet available to this profile. For hosted connectors such as Gmail, Core requires a ChatGPT connector account and the separate service authorization. Direct MCP plugins use their own service sign-in.")}
              </p>
            )}
            {operating && (
              <p role="status">
                {flow?.cancelled
                  ? t("Stopping and cleaning the owned operation…")
                  : t("Core operation: {phase}…", { phase: flow?.phase ?? "preparing" })}
              </p>
            )}
            {error && <p role="alert">{typeof error === "string" ? t("Error: {detail}", { detail: error }) : t(error.key)}</p>}
            {flow?.error && (
              <p role="alert">
                {flow.error.code}: {flow.error.message}
              </p>
            )}
            {flow?.phase === "uncertain" && (
              <p role="alert">
                {t("Installation state is not confirmed. Inspect the plugin again before retrying. No rollback is claimed.")}
              </p>
            )}
            {flow?.phase === "cancelled" && (
              <p role="status">
                {t("Cancelled before an installation change was sent.")}
              </p>
            )}
            {flow?.phase === "completed" && !operating && (
              <p role="status">
                {flow.action === "inspect"
                  ? t("Original plugin details loaded.")
                  : flow.action === "install"
                    ? t("Plugin installed and enabled; state verified by Core.")
                    : t("Plugin removed from this Synora profile; state verified by Core.")}
              </p>
            )}
            {detail && (
              <>
                <p>
                  {detail.description ??
                    detail.summary.interface?.longDescription}
                </p>
                <p>
                  {detail.summary.installed ? t("Installed") : t("Not installed")} ·{" "}
                  {detail.summary.enabled ? t("Enabled") : t("Disabled")} ·{" "}
                  {detail.summary.availability}
                </p>
                <p>
                  {t("Installation policy: {install}. Authentication policy: {auth}.", { install: detail.summary.installPolicy, auth: detail.summary.authPolicy })}
                </p>
                <h3>{t("Bundled capabilities")}</h3>
                <p>
                  {t("{skills} skills · {servers} MCP servers · {apps} connectors · {hooks} hooks · {tasks} scheduled tasks", {
                    skills: number(detail.skills.length), servers: number(detail.mcpServers.length),
                    apps: number(detail.apps.length), hooks: number(detail.hooks.length),
                    tasks: number(detail.scheduledTasks?.length ?? 0),
                  })}
                </p>
                {detail.skills.map((s) => (
                  <p key={s.name}>
                    <strong>{s.name}</strong>: {s.description}
                  </p>
                ))}
                {detail.mcpServers.map((name) => (
                  <p className="mono" key={name}>
                    MCP: {name}
                  </p>
                ))}
                {!!detail.mcpServers.length && (
                  <p>
                    {t("MCP browser sign-in is separate from installation. No browser is opened by this installation operation; authentication and callable tools must be checked separately.")}
                  </p>
                )}
                {detail.apps.map((app) => (
                  <p key={app.id}>
                    {t("Connector: {name} · {id}", { name: app.name, id: app.id })}
                  </p>
                ))}
                <details>
                  <summary>{t("Original plugin details")}</summary>
                  <pre>{JSON.stringify(detail, null, 2)}</pre>
                </details>
                <p>
                  {t("This is a metadata review, not a source-code audit. Installing third-party plugins may add executable tools, hooks and connector sign-in. Installed does not mean authenticated or callable. Start a new conversation to pick up newly installed capabilities.")}
                </p>
                <p>
                  {t("Removal affects this Synora profile only. Existing conversations and external connector grants are not deleted or revoked.")}
                </p>
                {!!detail.mcpServers.length && flow && (
                  <CorePluginSignIn
                    api={api}
                    plugin={flow}
                    disabled={pending || !!flow.busy}
                    onBusy={setSignInBusy}
                  />
                )}
                <label className="catalog-checkbox">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={changing || flow?.phase !== "completed"}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  {t("I have reviewed this plugin and confirm the selected installation change.")}
                </label>
                <div className="actions">
                  <button
                    disabled={
                      changing ||
                      !confirmed ||
                      flow?.phase !== "completed" ||
                      !!installReason
                    }
                    title={installReason ? t(installReason) : undefined}
                    onClick={() => change("install")}
                  >
                    {t("Install plugin")}
                  </button>
                  <button
                    disabled={
                      changing ||
                      !confirmed ||
                      flow?.phase !== "completed" ||
                      !!uninstallReason
                    }
                    title={uninstallReason ? t(uninstallReason) : undefined}
                    onClick={() => change("uninstall")}
                  >
                    {t("Remove plugin")}
                  </button>
                </div>
                {installReason && (
                  <p className="muted">{t("Install: {reason}", { reason: t(installReason) })}</p>
                )}
                {uninstallReason && (
                  <p className="muted">{t("Remove: {reason}", { reason: t(uninstallReason) })}</p>
                )}
              </>
            )}
            {!!flow?.installResult?.appsNeedingAuth.length && (
              <>
                <h3>{t("Connector authorization required")}</h3>
                {flow.installResult.appsNeedingAuth.map((app) => (
                  <p key={app.id}>
                    {app.name} · {app.id}
                  </p>
                ))}
              </>
            )}
            {flow?.mutationSent && !changing && (
              <p>
                {t("Refresh the Core catalog after closing this panel. Connector access must be verified separately.")}
              </p>
            )}
            {flow?.busy && !flow.cleanupFailed && (
              <button
                disabled={flow.cancelled}
                onClick={() =>
                  void run(
                    async () => value(await api.corePluginCancel(flow.id)),
                    true,
                  )
                }
              >
                {flow.mutationSent
                  ? t("Stop waiting and verify later")
                  : t("Cancel plugin operation")}
              </button>
            )}
            <button onClick={() => setOpen(false)}>{t("Close plugin panel")}</button>
          </section>
        </Modal>
      )}
    </>
  );
}
