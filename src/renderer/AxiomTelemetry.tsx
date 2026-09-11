import type { AxiomRequestMetrics } from "../shared/contracts";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";

export function AxiomTelemetry({
  requests = [],
  scope = "turn",
}: {
  requests?: AxiomRequestMetrics[];
  scope?: "turn" | "agent";
}) {
  const { t, number, locale } = useI18n(messages);
  const fixed = (value: number, digits: number) => new Intl.NumberFormat(locale === "pt" ? "pt-PT" : locale,
    { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  return (
    <article className="card axiom-telemetry">
      <h2>{t("Axiom response measurements")}</h2>
      <p className="muted">
        {t(scope === "agent" ? "Reported by Axiom on completed requests, correlated to this agent. Not a live GPU sample or a sustained throughput benchmark." : "Reported by Axiom on completed requests, correlated to this turn. Not a live GPU sample or a sustained throughput benchmark.")}
      </p>
      {!requests.length ? (
        <p>{t(scope === "agent" ? "No completed Axiom measurement is available for this agent." : "No completed Axiom measurement is available for this turn.")}</p>
      ) : (
        <>
          <dl>
            <dt>{t("Completed requests")}</dt>
            <dd>{number(requests.length)}</dd>
            <dt>{t("Thinking tokens")}</dt>
            <dd>
              {number(requests.reduce((n, r) => n + r.thinkingTokens, 0))}
            </dd>
            <dt>{t("Visible output tokens")}</dt>
            <dd>
              {number(requests.reduce((n, r) => n + r.visibleTokens, 0))}
            </dd>
          </dl>
          {requests.map((r) => (
            <details key={r.responseId}>
              <summary>
                {r.responseId} · {r.profile} · {r.decodePath}
              </summary>
              <dl>
                <dt>{t("Request session")}</dt>
                <dd className="mono">{r.sessionId}</dd>
                <dt>{t("Thread / turn")}</dt>
                <dd className="mono">
                  {r.threadId} / {r.turnId}
                </dd>
                <dt>{t("Model / path")}</dt>
                <dd>
                  {r.model} / {r.speculativeMode}
                </dd>
                <dt>{t("Input / generated")}</dt>
                <dd>
                  {number(r.inputTokens)} /{" "}
                  {number(r.outputTokens)}
                </dd>
                <dt>{t("Thinking / budget")}</dt>
                <dd>
                  {number(r.thinkingTokens)} /{" "}
                  {number(r.thinkingBudget)}
                </dd>
                <dt>{t("Prefill / decode")}</dt>
                <dd>
                  {fixed(r.prefillSeconds, 3)} s / {fixed(r.decodeSeconds, 3)}{" "}
                  s
                </dd>
                <dt>{t("Time to first token")}</dt>
                <dd>{t("{seconds} s (kernel-reported)", { seconds: fixed(r.ttftSeconds, 3) })}</dd>
                <dt>{t("Decode / visible")}</dt>
                <dd>
                  {t("{decode} / {visible} tok/s (this request)", { decode: fixed(r.decodeTokensPerSecond, 1), visible: fixed(r.visibleTokensPerSecond, 1) })}
                </dd>
                <dt>{t("Prefix reused / prefilled")}</dt>
                <dd>
                  {t("{reused} / {prefilled} tokens", { reused: number(r.prefixHitTokens), prefilled: number(r.suffixPrefillTokens) })}
                </dd>
                <dt>{t("Observed")}</dt>
                <dd>{new Date(r.observedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale)}</dd>
              </dl>
            </details>
          ))}
        </>
      )}
    </article>
  );
}
