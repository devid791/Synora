import { useId, type ReactNode } from "react";
import { Bot, Monitor, Moon, Sun } from "lucide-react";
import type { AppState, PlatformCapabilities } from "../shared/contracts";
import { PermissionPicker } from "./PermissionPicker";
import { useI18n } from "./i18n";
import { messages } from "./locales/settings";

export function GeneralSettings({
  state,
  capabilities,
  busy,
  pending,
  error,
  save,
  children,
}: {
  state: AppState;
  capabilities: PlatformCapabilities | null;
  busy: boolean;
  pending: boolean;
  error: string;
  save: (patch: Partial<AppState["preferences"]>) => Promise<void>;
  children?: ReactNode;
}) {
  const { t } = useI18n(messages);
  const id = useId();
  const pref = state.preferences;
  const eligible = state.presets.filter((p) => p.enabled);
  const selectedBot = pref.defaultBotId ?? "";
  const unavailableBot =
    !!selectedBot && !eligible.some((p) => p.id === selectedBot);
  // The mutation hook owns the visible failure. Never apply an optimistic value.
  const change = (patch: Partial<AppState["preferences"]>) =>
    void save(patch).catch(() => {});
  return (
    <article className="card general-settings" aria-labelledby={`${id}-title`}>
      <div className="general-settings-heading">
        <h2 id={`${id}-title`}>{t("General")}</h2>
        <p>{t("Your defaults, your workspace.")}</p>
      </div>
      {(pending || error) && (
        <div className="settings-save-feedback">
          {pending && (
            <p className="settings-save-status" role="status">
              {t("Saving preferences…")}
            </p>
          )}
          {error && (
            <p className="settings-save-error" role="alert">
              {t("Could not save. Your previous setting is unchanged.")} {error}
            </p>
          )}
        </div>
      )}
      <div className="general-setting-row">
        <div className="general-setting-copy">
          <label htmlFor={`${id}-bot`}>{t("Default bot")}</label>
          <p id={`${id}-bot-help`}>
            {t(
              "Used for new conversations only. Existing conversations keep their bot and instructions.",
            )}
          </p>
        </div>
        <div className="general-setting-control">
          <Bot aria-hidden="true" size={16} />
          <select
            id={`${id}-bot`}
            value={selectedBot}
            disabled={busy}
            aria-describedby={`${id}-bot-help`}
            onChange={(e) =>
              change({ defaultBotId: e.currentTarget.value || null })
            }
          >
            <option value="">Synora Standard</option>
            {unavailableBot && (
              <option value={selectedBot} disabled>
                {t("Unavailable bot — choose another")}
              </option>
            )}
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div
        className="general-setting-row"
        role="group"
        aria-labelledby={`${id}-permission`}
      >
        <div className="general-setting-copy">
          <strong id={`${id}-permission`}>{t("Default permissions")}</strong>
          <p>
            {t(
              "Applies to new sessions. The active session keeps its current permissions.",
            )}
          </p>
        </div>
        <PermissionPicker
          mode={pref.permission ?? "ask"}
          busy={busy}
          change={(permission) => save({ permission })}
        />
      </div>
      {children}
      <div className="general-setting-row">
        <div className="general-setting-copy">
          <strong id={`${id}-appearance`}>{t("Appearance")}</strong>
          <p id={`${id}-appearance-help`}>
            {t(
              "Choose a light or dark interface, or follow your system automatically.",
            )}
          </p>
        </div>
        <div
          className="appearance-options"
          role="group"
          aria-labelledby={`${id}-appearance`}
          aria-describedby={`${id}-appearance-help`}
        >
          {(
            [
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
              ["system", "System", Monitor],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              aria-pressed={(pref.theme ?? "system") === value}
              disabled={busy}
              onClick={() => {
                if ((pref.theme ?? "system") !== value)
                  change({ theme: value });
              }}
            >
              <Icon aria-hidden="true" />
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="general-setting-row">
        <div className="general-setting-copy">
          <label htmlFor={`${id}-busy-enter`}>{t("Enter while working")}</label>
          <p id={`${id}-busy-enter-help`}>
            {t(
              "Queue sends after the current turn. Steer guides the active turn. Cmd/Ctrl+Enter uses the other action. Shift+Enter adds a new line.",
            )}
          </p>
        </div>
        <select
          id={`${id}-busy-enter`}
          value={pref.busyEnterBehavior ?? "queue"}
          disabled={busy}
          aria-describedby={`${id}-busy-enter-help`}
          onChange={(e) =>
            change({
              busyEnterBehavior: e.currentTarget.value as "queue" | "steer",
            })
          }
        >
          <option value="queue">{t("Queue")}</option>
          <option value="steer">{t("Steer")}</option>
        </select>
      </div>
      {(
        [
          [
            "launchAtLogin",
            "Launch at login",
            "Open Synora automatically when you sign in to this computer.",
          ],
          [
            "systemNotifications",
            "System notifications",
            "Notify about engine problems, repeated failures and recovery. Message content is never included.",
          ],
        ] as const
      ).map(([key, label, description]) => {
        const capability = capabilities?.[key];
        const supported = capability?.supported === true;
        return (
          <div
            key={key}
            className="general-setting-row"
            role="group"
            aria-labelledby={`${id}-${key}-label`}
          >
            <div className="general-setting-copy">
              <strong id={`${id}-${key}-label`}>{t(label)}</strong>
              <p id={`${id}-${key}-help`}>{t(description)}</p>
              {!supported && (
                <p
                  className="native-setting-unavailable"
                  id={`${id}-${key}-unavailable`}
                >
                  {capabilities
                    ? t(
                        "This host has no verified native integration for this setting.",
                      )
                    : t("Checking system integration…")}
                </p>
              )}
            </div>
            {supported ? (
              <input
                className="settings-switch"
                type="checkbox"
                role="switch"
                aria-labelledby={`${id}-${key}-label`}
                aria-describedby={`${id}-${key}-help`}
                checked={pref[key] ?? key === "systemNotifications"}
                disabled={busy}
                onChange={(e) => change({ [key]: e.currentTarget.checked })}
              />
            ) : (
              <span
                className="badge"
                aria-describedby={`${id}-${key}-unavailable`}
              >
                {capabilities ? t("Unavailable") : t("Checking…")}
              </span>
            )}
          </div>
        );
      })}
    </article>
  );
}
