import { useLayoutEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const darkMode = () =>
  window.matchMedia("(prefers-color-scheme: dark)").matches;
const subscribe = (notify: () => void) => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const noSubscription = () => () => {};

const observeResolvedTheme = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
/** Read the app's resolved theme without changing preferences or OS listeners. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(observeResolvedTheme,
    () => document.documentElement.dataset.theme === "light" ? "light" : "dark",
    () => "dark");
}

/** Runs for the lifetime of App, not the Settings page. Only saved preferences
 * reach this hook; OS changes never write preferences or touch the engine. */
export function useSettingsTheme(theme: ThemePreference = "system") {
  const systemDark = useSyncExternalStore(
    theme === "system" ? subscribe : noSubscription,
    darkMode,
    () => true,
  );
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = theme;
  }, [resolved, theme]);
  return resolved;
}
