import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/providers";
import {
  providerDefinitions,
  type ProviderType,
} from "../shared/provider-registry";
import type { Integration } from "../shared/contracts";

export function ProviderDirectory({
  providers,
  busy,
  choose,
}: {
  providers: Integration[];
  busy: boolean;
  choose: (type: ProviderType) => void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  return (
    <section aria-label={t("Provider directory")} className="provider-directory">
      <h2>{t("Add a model provider")}</h2>
      <p>{t("Choose a provider. Its address and authentication method are filled in for you; connect your own account before use.")}</p>
      <div className="provider-tiles">
        {(Object.keys(providerDefinitions) as ProviderType[]).map((id) => {
          const p = providerDefinitions[id];
          return (
            <button
              key={id}
              type="button"
              disabled={busy}
              onClick={() => choose(id)}
            >
              <strong>{id === "compatible" ? t("Custom compatible endpoint") : p.name}</strong>
              <small>
                {id === "openai"
                  ? t("ChatGPT browser sign-in · device code · API key")
                  : id === "openrouter"
                    ? t("Browser sign-in or API key")
                    : id === "gemini"
                      ? t("API key or registered Google OAuth client")
                      : id === "axiom" || id === "compatible"
                        ? t("Your endpoint · optional Bearer token")
                        : t("API key")}
              </small>
              <span>
                {providers.some(
                  (v) => v.kind === "provider" && v.providerType === id,
                )
                  ? t("Add another configuration")
                  : t("Connect provider")}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
