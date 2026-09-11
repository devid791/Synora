import { z } from "zod";
export const localeSchema = z.enum(["en", "it", "fr", "de", "es", "pt", "nl"]);
export type Locale = z.infer<typeof localeSchema>;
export const localeNames: Record<Locale, string> = {
  en: "English",
  it: "Italiano",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  pt: "Português",
  nl: "Nederlands",
};
