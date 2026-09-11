import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/providers";
import { useState } from "react";
import {
  compatibleSettingsSchema,
  type CompatibleSettings,
} from "../shared/compatible-provider";

/** Missing metadata is not a model-name heuristic or an Axiom context profile. */
export function CompatibleSettingsEditor({
  value,
  onChange,
}: {
  value: CompatibleSettings;
  onChange(value: CompatibleSettings): void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const [text, setText] = useState(
    JSON.stringify(value.modelOverrides ?? {}, null, 2),
  );
  const [error, setError] = useState<{ detail?: string } | null>(null);
  return (
    <fieldset className="compatible-settings">
      <legend>{t("Responses compatibility contract")}</legend>
      <p>{t("This adapter requires streaming")}{" "}<code>/responses</code>{" "}{t("and")}{" "}
        <code>/models</code>{t(". Chat-only endpoints are not supported. Model identities come from this endpoint, not this form.")}</p>
      <label>{t("Protocol")}<select aria-label={t("Compatible protocol")} value="responses" disabled>
          <option value="responses">OpenAI Responses</option>
        </select>
      </label>
      <label>{t("Model capability overrides (JSON)")}<textarea
          aria-label={t("Model capability overrides")}
          rows={8}
          value={text}
          spellCheck={false}
          onInvalid={(e) => {
            if (error) e.currentTarget.setCustomValidity(
              t("Invalid capability JSON") + (error.detail ? `: ${error.detail}` : ""),
            );
          }}
          onChange={(e) => {
            setText(e.target.value);
            try {
              const next = compatibleSettingsSchema.parse({
                protocol: "responses",
                modelOverrides: JSON.parse(e.target.value),
              });
              e.target.setCustomValidity("");
              setError(null);
              onChange(next);
            } catch (cause) {
              const detail = cause instanceof Error ? cause.message : undefined;
              e.target.setCustomValidity(t("Invalid capability JSON") + (detail ? `: ${detail}` : ""));
              setError({ detail });
            }
          }}
        />
      </label>
      {error && <p role="alert">{t("Invalid capability JSON")}{error.detail ? `: ${error.detail}` : ""}</p>}
      <p>{t("Use")}{" "}<code>{"{}"}</code>{" "}{t("when the catalog supplies complete metadata. Otherwise enter only capabilities verified with the endpoint operator. These are operator assertions, not measured performance or automatic qualification.")}</p>
      <details>
        <summary>{t("Capability format example (replace model ID and values)")}</summary>
        <pre>
          {JSON.stringify(
            {
              "your-model-id": {
                contextWindow: 32768,
                reasoningEfforts: [],
                inputModalities: ["text"],
                outputModalities: ["text"],
                tools: true,
                supportedParameters: ["tools"],
              },
            },
            null,
            2,
          )}
        </pre>
      </details>
      <p>{t("API base URL is editable. HTTP sends prompts and results in plaintext: use it only for trusted private endpoints without a token. Credentials require HTTPS or loopback.")}</p>
    </fieldset>
  );
}
