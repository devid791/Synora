import { useEffect, useState, useRef } from "react";
import type { DesktopAPI, Result } from "../shared/contracts";
import type { CoreUpdateStatus } from "../shared/core-update";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
export function CoreUpdateSettings({
  api,
  busy,
}: {
  api: DesktopAPI;
  busy: boolean;
}) {
  const { t, locale } = useI18n(messages);
  const [status, setStatus] = useState<CoreUpdateStatus | null>(null);
  const [error, setError] = useState<string | { key: string }>("");
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const savingAutomatic = useRef(false);
  useEffect(() => {
    let live = true,
      running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try {
        const result = await api.coreUpdateStatus();
        if (live) {
          if (result.ok && !savingAutomatic.current) setStatus(result.value);
          else if (result.ok) {
            /* keep the pending checkbox value until acknowledged */
          } else setError(result.error.message);
        }
      } catch {
        if (live) setError({ key: "Could not read App Server update status" });
      } finally {
        running = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  const run = async (operation: () => Promise<Result<CoreUpdateStatus>>) => {
    setPending(true);
    setError("");
    try {
      const result = await operation();
      if (!result.ok) throw Error(result.error.message);
      setStatus(result.value);
      setConfirm(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      const latest = await api.coreUpdateStatus();
      if (latest.ok) setStatus(latest.value);
    } finally {
      setPending(false);
    }
  };
  const changing = !!status && !["idle", "failed"].includes(status.phase);
  // Match only application-owned templates. Versions and original error details
  // remain untouched; unknown backend messages retain the English fallback.
  const updateMessage = (message: string) => {
    const templates = [
      "Core {version} is qualified and queued. Waiting for idle sessions before automatic installation.",
      "Core {version} is available upstream. Only versions qualified for this Synora build can be installed.",
      "Core {version} passed the signed update channel checks and will install when idle.",
      "Core {version} is available upstream; waiting for automated compatibility results in the signed channel.",
      "Signed Core channel unavailable; installed runtime unchanged. {detail}",
      "App Server {version} activated. Previous executable and data retained. No active turn was interrupted.",
      "Restored App Server {version} and its saved session state. Newer data remains in the retained generation.",
      "Update check failed; installed runtime unchanged. {detail}",
      "Automatic update state could not be recorded: {detail}",
    ];
    for (const template of templates) {
      const match = /\{(version|detail)\}/.exec(template)!;
      const prefix = template.slice(0, match.index);
      const suffix = template.slice(match.index + match[0].length);
      if (message.startsWith(prefix) && message.endsWith(suffix)) {
        const value = message.slice(prefix.length, message.length - suffix.length);
        if (value) return t(template, { [match[1]]: value });
      }
    }
    return [
      "Using the bundled pinned App Server. Availability is not qualification.",
      "No newer stable upstream version was found.",
      "A host-supplied Core executable is active. Managed updates cannot replace an external executable.",
    ].includes(message) ? t(message) : message;
  };
  return (
    <article
      className="card core-update-settings"
      aria-label={t("App Server updates")}
    >
      <h2>{t("App Server updates")}</h2>
      <p className="muted">
        {t("Qualified updates install automatically when sessions and agents are idle. Synora verifies the package and startup, and retains the previous runtime and data for recovery. Unqualified upstream versions are never silently activated. Manual installation remains available.")}
      </p>
      <p className="muted">
        {t("New compatible Core versions can arrive through the signed update channel without reinstalling Synora. Failed or incomplete compatibility checks keep the current runtime in place.")}
      </p>
      {!status && !error && <p role="status">{t("Reading the installed runtime…")}</p>}
      {status && (
        <>
          <dl className="diagnostics-grid">
            <dt>{t("Selected runtime")}</dt>
            <dd>{status.currentVersion}</dd>
            <dt>{t("Upstream available")}</dt>
            <dd>{status.latestVersion ?? t("Not checked")}</dd>
            <dt>{t("Qualified update")}</dt>
            <dd>
              {status.eligibleVersion ?? t("None for this build and platform")}
            </dd>
            <dt>{t("Last successful check")}</dt>
            <dd>
              {status.checkedAt
                ? new Date(status.checkedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale)
                : t("Not checked")}
            </dd>
            <dt>{t("Previous runtime")}</dt>
            <dd>{status.previousVersion ?? t("No update installed")}</dd>
          </dl>
          <label>
            <input
              type="checkbox"
              aria-label={t("Automatically check App Server updates")}
              checked={status.automatic}
              disabled={pending || changing || status.checking}
              onChange={(e) => {
                const enabled = e.target.checked;
                savingAutomatic.current = true;
                setStatus({ ...status, automatic: enabled });
                void run(() => api.coreUpdateAutomatic(enabled)).finally(() => {
                  savingAutomatic.current = false;
                });
              }}
            />{" "}
            {t("Check every six hours and install qualified updates when idle")}
          </label>
          <div className="actions">
            <button
              disabled={pending || changing || status.checking}
              onClick={() => void run(() => api.coreUpdateCheck())}
            >
              {t("Check for App Server updates")}
            </button>
            <button
              disabled={
                pending ||
                changing ||
                busy ||
                status.checking ||
                !status.eligibleVersion ||
                !!status.disabledReason
              }
              onClick={() =>
                void run(() => api.coreUpdateInstall(status.eligibleVersion!))
              }
            >
              {t("Update App Server")}
            </button>
          </div>
          {busy && (
            <p className="muted">
              {t("Finish active turns and agents before installing or restoring App Server.")}
            </p>
          )}
          {status.disabledReason && (
            <p className="notice">{updateMessage(status.disabledReason)}</p>
          )}
          <p role="status" aria-live="polite">
            {status.checking
              ? t("Checking upstream version metadata…")
              : changing
                ? t("Update phase: {phase}… {message}", { phase: status.phase, message: updateMessage(status.message) })
                : updateMessage(status.message)}
          </p>
          {status.checks.length > 0 && (
            <ul>
              {status.checks.map((c) => (
                <li key={c}>{t(c)}</li>
              ))}
            </ul>
          )}
          {status.recoveryId && (
            <details>
              <summary>{t("Restore previous App Server")}</summary>
              <p>
                {t("Restores the previous engine and the Synora session/configuration snapshot from before the update. Newer engine data and a copy of the current Synora state are retained separately. Workspace files and saved provider keys are not rolled back.")}
              </p>
              <label>
                <input
                  type="checkbox"
                  aria-label={t("Confirm App Server recovery")}
                  checked={confirm}
                  disabled={pending || changing || busy}
                  onChange={(e) => setConfirm(e.target.checked)}
                />{" "}
                {t("Restore the saved session state")}
              </label>
              <button
                disabled={
                  !confirm ||
                  pending ||
                  changing ||
                  busy ||
                  !!status.disabledReason
                }
                onClick={() =>
                  void run(() =>
                    api.coreUpdateRollback(status.recoveryId!, true),
                  )
                }
              >
                {t("Restore previous App Server")}
              </button>
            </details>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="notice error">
          {typeof error === "string" ? t("Error: {detail}", { detail: error }) : t(error.key)}
        </p>
      )}
    </article>
  );
}
