import { useCallback, useState, type RefObject } from "react";
import type { AppState, DesktopAPI } from "../shared/contracts";
import { useI18n } from "./i18n";
import { messages } from "./locales/settings";

/** App owns this state so navigation cannot release a pending preference write. */
export function useSettingsPreferences(
  api: DesktopAPI,
  updated: (state: AppState) => void,
  write: RefObject<Promise<void> | null>,
) {
  const { t } = useI18n(messages);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const save = useCallback(
    async (patch: Partial<AppState["preferences"]>) => {
      if (write.current)
        throw Error(t("Wait for the current preference to finish saving."));
      setPending(true);
      setError("");
      const operation = (async () => {
        const result = await api.preferences(patch);
        if (!result.ok) throw Error(result.error.message);
        updated(result.value);
      })();
      write.current = operation;
      try {
        await operation;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        if (write.current === operation) write.current = null;
        setPending(false);
      }
    },
    [api, updated, write, t],
  );
  return { pending, error, save };
}
