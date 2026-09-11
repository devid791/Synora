import { reportedReasoning } from "./message-text";
import { useI18n } from "./i18n";
import { messages } from "./locales/orchestration";

export function MessageText({
  text,
  assistant = false,
}: {
  text: string;
  assistant?: boolean;
}) {
  const { t } = useI18n(messages);
  const reasoning = assistant ? reportedReasoning(text) : null;
  if (!reasoning) return <div className="message-text">{text}</div>;
  return (
    <>
      <details className="reported-reasoning">
        <summary>{t("Model reasoning · expand to read")}</summary>
        <div className="message-text">{reasoning.block}</div>
      </details>
      {reasoning.answer && (
        <div className="message-text">{reasoning.answer}</div>
      )}
    </>
  );
}
