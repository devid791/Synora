import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
import type { CompactionRecord } from "../shared/compaction";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
export function ToolActivity({
  item,
  simulated,
  compaction,
}: {
  item: ThreadItem;
  simulated: boolean;
  compaction?: CompactionRecord;
}) {
  const { t, locale, number } = useI18n(messages satisfies Messages);
  if (item.type === "userMessage" || item.type === "agentMessage") return null;
  if (item.type === "contextCompaction")
    return (
      <div
        className="tool-call"
        data-item-id={item.id}
        aria-label={t("Context compaction")}
      >
        <strong>{t("Context compaction")}</strong>
        <span role="status" className="badge">
          {compaction?.status ?? t("recorded; outcome unavailable")}
        </span>
        <p>
          {t("Core manages the model's working context. Your visible conversation history and draft are retained.")}
        </p>
        {compaction?.completedAt !== undefined && (
          <small>
            {t("Observed duration: {seconds} s", {
              seconds: ((compaction.completedAt - compaction.startedAt) / 1000).toLocaleString(
                locale === "pt" ? "pt-PT" : locale,
                { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false },
              ),
            })}
          </small>
        )}
        <details>
          <summary>{t("Compaction identity")}</summary>
          <pre>{JSON.stringify(compaction ?? { id: item.id }, null, 2)}</pre>
        </details>
      </div>
    );
  const status = "status" in item ? String(item.status) : "";
  return (
    <div className="tool-call" data-item-id={item.id}>
      <strong>
        {item.type === "mcpToolCall"
          ? item.tool
          : item.type === "dynamicToolCall"
            ? item.tool
            : item.type === "commandExecution"
              ? t("Command")
              : item.type === "fileChange"
                ? t("File changes")
                : item.type}
      </strong>
      <span className="badge">
        {simulated ? t("Simulated") : t("Live")} · {status}
      </span>
      {item.type === "commandExecution" ? (
        <>
          <pre>{item.command}</pre>
          <pre>{item.aggregatedOutput}</pre>
          <p>{t("Exit: {code}", { code: item.exitCode ?? t("pending") })}</p>
        </>
      ) : item.type === "mcpToolCall" ? (
        <>
          <p>
            {t("Server: {server} · {duration} ms", { server: item.server, duration: item.durationMs == null ? t("pending") : number(item.durationMs) })}
          </p>
          <details>
            <summary>{t("Arguments")}</summary>
            <pre>{JSON.stringify(item.arguments, null, 2)}</pre>
          </details>
          {item.error && <p className="form-error">{item.error.message}</p>}
          {item.result && (
            <details open>
              <summary>{t("Tool result · untrusted content")}</summary>
              {item.result.content.map((c, i) => (
                <pre key={i}>
                  {c &&
                  typeof c === "object" &&
                  !Array.isArray(c) &&
                  typeof c.text === "string"
                    ? c.text
                    : JSON.stringify(c, null, 2)}
                </pre>
              ))}
              {item.result.structuredContent && (
                <pre>
                  {JSON.stringify(item.result.structuredContent, null, 2)}
                </pre>
              )}
            </details>
          )}
        </>
      ) : item.type === "dynamicToolCall" ? (
        <>
          <pre>{JSON.stringify(item.arguments, null, 2)}</pre>
          {item.contentItems?.map((c, i) => (
            <p key={i}>{c.type === "inputText" ? c.text : JSON.stringify(c)}</p>
          ))}
        </>
      ) : (
        <details>
          <summary>{t("Activity details")}</summary>
          <pre>{JSON.stringify(item, null, 2)}</pre>
        </details>
      )}
      <small className="mono">{t("item {id}", { id: item.id })}</small>
    </div>
  );
}
