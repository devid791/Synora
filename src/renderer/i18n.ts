import { useCallback, useSyncExternalStore } from "react";
import { localeSchema, type Locale } from "../shared/locale";
export { localeNames } from "../shared/locale";
export type { Locale } from "../shared/locale";
// Exact order: Italian, French, German, Spanish, Portuguese (Portugal), Dutch.
export type Messages = Record<
  string,
  readonly [string, string, string, string, string, string]
>;
const indexes = { it: 0, fr: 1, de: 2, es: 3, pt: 4, nl: 5 } as const;
let selected: Locale = "en";
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function setLocale(value: Locale) {
  const next = localeSchema.parse(value);
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (selected === next) return;
  selected = next;
  for (const fn of listeners) fn();
}
export function translate(
  messages: Messages | undefined,
  locale: Locale,
  source: string,
  params?: Record<string, string | number>,
) {
  const template =
    locale === "en"
      ? source
      : (messages?.[source]?.[indexes[locale]] ?? source);
  return template.replace(
    /\{([A-Za-z_][A-Za-z_0-9]*)\}/g,
    (match, key: string) =>
      params && Object.hasOwn(params, key) ? String(params[key]) : match,
  );
}
/** Translates only explicitly marked app-owned UI; never walks/mutates the DOM,
 * user content, tool results or wire protocol values. Locale changes don't remount Core. */
export function useI18n(messages?: Messages) {
  const locale = useSyncExternalStore(
    subscribe,
    () => selected,
    () => "en" as Locale,
  );
  const t = useCallback(
    (source: string, params?: Record<string, string | number>) =>
      translate(messages, locale, source, params),
    [messages, locale],
  );
  const number = useCallback(
    (n: number) => n.toLocaleString(locale === "pt" ? "pt-PT" : locale),
    [locale],
  );
  return { t, locale, number };
}
