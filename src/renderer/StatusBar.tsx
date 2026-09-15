import type {
  DesktopAPI,
  EngineSnapshot,
  LocalMetrics,
} from "../shared/contracts";
import { AppServerStatus } from "./AppServerConnection";
import { LiveTelemetry } from "./LiveTelemetry";
import { useI18n } from "./i18n";
import { messages as appMessages } from "./locales/app";
import { messages as statusMessages } from "./locales/status-bar";

const messages = { ...appMessages, ...statusMessages };

/** Global transport and local services are separate from the selected chat's
 * activity. Detailed diagnostics never compete with the composer for space. */
export function StatusBar({
  api,
  engine,
  conversationEngine,
  live,
  axiom,
  providerLabel,
  providerKey,
  metrics,
  platform,
  protocolVersion,
  onOverlayChange,
}: {
  api: Pick<DesktopAPI, "backendStatus">;
  engine: EngineSnapshot;
  conversationEngine: EngineSnapshot;
  live: boolean;
  axiom: boolean;
  providerLabel: string;
  providerKey: string;
  metrics: LocalMetrics | null;
  platform: string;
  protocolVersion: string;
  onOverlayChange?: (open: boolean) => void;
}) {
  const { t, number } = useI18n(messages);
  const provider = live ? providerLabel : t("simulation");
  return (
    <footer className="status-bar" aria-label={t("Session status")}>
      <LiveTelemetry
        key={providerKey}
        api={api}
        engine={conversationEngine}
        axiom={axiom}
        onOverlayChange={onOverlayChange}
        connection={
          <div className="status-connection">
            <span
              className={`status-provider${live ? "" : " simulated-text"}`}
              title={`${t("Engine:")} ${provider}`}
            >
              {provider}
            </span>
            {live && <AppServerStatus engine={engine} />}
          </div>
        }
        diagnostics={
          <section>
            <h3>{t("Local services")}</h3>
            <div className="telemetry-values">
              <span>
                {t("Client application · {platform}", {
                  platform:
                    platform === "win32"
                      ? "Windows"
                      : platform === "darwin"
                        ? "macOS"
                        : platform,
                })}
              </span>
              <span>
                {t("Engine:")} {provider}
              </span>
              {live && <AppServerStatus engine={engine} />}
              <span>
                {t("App RAM")}{" "}
                {metrics
                  ? `${number(Math.round((metrics.rssBytes / 1024 ** 2) * 10) / 10)} MB`
                  : "—"}
              </span>
              <span>PTY {metrics ? number(metrics.terminalCount) : "—"}</span>
              <span>
                {t("Codex protocol {version} · {platform}", {
                  version: protocolVersion,
                  platform,
                })}
              </span>
            </div>
          </section>
        }
      />
    </footer>
  );
}
