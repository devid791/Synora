import type { EngineSnapshot } from "../shared/contracts";
import { translate, useI18n } from "./i18n";
import { messages } from "./locales/composer";

export function appServerReady(engine: EngineSnapshot): boolean {
  return (
    engine.connection === "live" &&
    (!engine.appServer || engine.appServer.phase === "ready")
  );
}

export function appServerMessage(
  engine: EngineSnapshot,
  t: ReturnType<typeof useI18n>["t"] = (key, params) =>
    translate(undefined, "en", key, params),
): string {
  const state = engine.appServer;
  if (state?.phase === "starting")
    return t("Starting App Server… No model request is being sent.");
  if (state?.phase === "reconnecting")
    return t(
      "Reconnecting App Server automatically… Previous requests will not be sent again.",
    );
  if (appServerReady(engine))
    return t("App Server connected{pid}. Kept ready between messages.", {
      pid: state?.pid ? ` · PID ${state.pid}` : "",
    });
  return `${t("App Server is unavailable. Automatic reconnection is enabled.")}${state?.message ? ` ${state.message}` : ""}`;
}

export function AppServerConnection({
  engine,
  busy,
  reconnect,
}: {
  engine: EngineSnapshot;
  busy: boolean;
  reconnect: () => void;
}) {
  const { t } = useI18n(messages);
  if (appServerReady(engine)) return null;
  return (
    <div
      className="notice"
      data-testid="app-server-notice"
      role="status"
      aria-label={t("App Server connection")}
    >
      <span>{appServerMessage(engine, t)}</span>
      {engine.connection !== "live" && (
        <button
          disabled={busy || engine.appServer?.phase === "starting"}
          onClick={reconnect}
        >
          {t("Reconnect")}
        </button>
      )}
    </div>
  );
}

/** Global transport state, separate from per-conversation usage and GPU state. */
export function AppServerStatus({ engine }: { engine: EngineSnapshot }) {
  const { t } = useI18n(messages);
  const phase = appServerReady(engine)
    ? "ready"
    : engine.appServer?.phase === "starting"
      ? "starting"
      : engine.appServer?.phase === "reconnecting"
        ? "reconnecting"
        : "offline";
  const label =
    phase === "ready"
      ? t("Connected")
      : phase === "starting"
        ? t("Connecting…")
        : phase === "reconnecting"
          ? t("Reconnecting…")
          : t("Offline");
  const detail = appServerMessage(engine, t);
  return (
    <span
      className="app-server-status"
      data-phase={phase}
      role="status"
      aria-label={detail}
      title={detail}
      tabIndex={0}
    >
      <i className="dot" aria-hidden="true" />
      App Server · {label}
    </span>
  );
}
