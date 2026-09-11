import type { AgentRecord } from "../shared/contracts";
import { AxiomTelemetry } from "./AxiomTelemetry";
import { ToolActivity } from "./ToolActivity";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
import { OpenBeside } from "./ConversationSplit";
import { MessageText } from "./MessageText";

export function AgentCard({
  agent: a,
  openParent,
  inspect,
}: {
  agent: AgentRecord;
  openParent: () => void;
  inspect?: () => void;
}) {
  const { t, locale } = useI18n(messages satisfies Messages);
  return (
    <article className="card agent-card" aria-label={t("Agent {name}", { name: a.name })}>
      <div className="card-title">
        <div className="avatar" aria-hidden="true">
          {a.name[0]}
        </div>
        <strong>{a.name}</strong>
        <span className="badge">
          {a.simulated ? t("Simulated") : t("Live")} · {a.status}
        </span>
        {!a.simulated && (
          <span className="badge">
            {a.closed ? t("Closed") : t("Closure not reported")}
          </span>
        )}
      </div>
      <p>{a.task || t("Task not reported yet")}</p>
      <div className="agent-result">
        <MessageText assistant text={a.result ||
          (a.simulated
            ? t("Waiting for simulated result…")
            : t("No result reported yet"))} />
      </div>
      {a.metadataError && (
        <p className="form-error" role="status">
          {t("Metadata unavailable: {error}. Original activity is retained.", { error: a.metadataError })}
        </p>
      )}
      <details>
        <summary>{t("Identity and timing")}</summary>
        <dl>
          <dt>{t("Agent thread")}</dt>
          <dd className="mono">{a.id}</dd>
          <dt>{t("Parent thread")}</dt>
          <dd className="mono">{a.parentId}</dd>
          <dt>{t("Core child session")}</dt>
          <dd className="mono">{a.coreSessionId ?? t("Not reported")}</dd>
          <dt>{t("Latest turn")}</dt>
          <dd className="mono">{a.turnId ?? t("Not reported")}</dd>
          <dt>{t("Model / reasoning")}</dt>
          <dd>
            {a.model ?? t("Not reported")} / {a.profile ?? t("Not reported")}
          </dd>
          <dt>{t("Started")}</dt>
          <dd>
            {a.startedAt === undefined
              ? t("Not reported")
              : new Date(a.startedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale)}
          </dd>
          <dt>{t("Completed")}</dt>
          <dd>
            {a.completedAt === undefined
              ? t("Not reported")
              : new Date(a.completedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale)}
          </dd>
        </dl>
      </details>
      <details>
        <summary>{t("Tool activity")}</summary>
        {!a.activity?.some(
          (i) => i.type !== "agentMessage" && i.type !== "userMessage",
        ) && <p>{t("No tool activity reported.")}</p>}
        {a.activity?.map((item) => (
          <ToolActivity key={item.id} item={item} simulated={a.simulated} />
        ))}
      </details>
      {!a.simulated && (
        <AxiomTelemetry requests={a.backendRequests} scope="agent" />
      )}
      <button onClick={openParent}>{t("Open parent conversation")}</button>
      {inspect && <OpenBeside open={inspect} />}
    </article>
  );
}
