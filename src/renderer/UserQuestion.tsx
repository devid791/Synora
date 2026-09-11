import { useState } from "react";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
import type {
  DesktopAPI,
  EngineSnapshot,
  UserQuestion as Request,
} from "../shared/contracts";

export function UserQuestion({
  request,
  api,
  updated,
}: {
  request: Request;
  api: DesktopAPI;
  updated: (s: EngineSnapshot) => void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [custom, setCustom] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="approval user-question"
      aria-label={t("Model question")}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) return;
        setPending(true);
        setError("");
        void api
          .engineAnswer(
            request.id,
            Object.fromEntries(
              request.params.questions.map((q) => [
                q.id,
                [answers[q.id] ?? ""],
              ]),
            ),
          )
          .then((r) => {
            if (!r.ok) throw new Error(r.error.message);
            updated(r.value);
          })
          .catch((e) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setPending(false));
      }}
    >
      <strong>
        {request.params.isBlocking
          ? t("Your answer is needed")
          : t("Question · the model can continue working")}
      </strong>
      <small className="mono">
        {t("Thread {thread} · item {item}", { thread: request.params.threadId, item: request.params.itemId })}
      </small>
      {request.params.questions.map((q) => (
        <fieldset key={q.id} disabled={pending}>
          <legend>{q.header}</legend>
          <p>{q.question}</p>
          {q.options &&
            !q.isSecret &&
            q.options.map((o) => (
              <label className="check" key={o.label}>
                <input
                  type="radio"
                  name={`${request.id}-${q.id}`}
                  checked={!custom[q.id] && answers[q.id] === o.label}
                  onChange={() => {
                    setCustom((v) => ({ ...v, [q.id]: false }));
                    setAnswers((v) => ({ ...v, [q.id]: o.label }));
                  }}
                />
                <span>
                  {o.label}
                  <small>{o.description}</small>
                </span>
              </label>
            ))}
          {q.options && q.isOther && !q.isSecret && (
            <label className="check">
              <input
                type="radio"
                name={`${request.id}-${q.id}`}
                checked={!!custom[q.id]}
                onChange={() => {
                  setCustom((v) => ({ ...v, [q.id]: true }));
                  setAnswers((v) => ({ ...v, [q.id]: "" }));
                }}
              />
              {t("Custom answer")}
            </label>
          )}
          {(!q.options || custom[q.id] || q.isSecret) && (
            <label>
              {q.isSecret ? t("Private answer") : t("Your answer")}
              <input
                type={q.isSecret ? "password" : "text"}
                aria-label={t("Answer: {header}", { header: q.header })}
                autoComplete="off"
                required
                maxLength={16000}
                value={answers[q.id] ?? ""}
                onChange={(e) =>
                  setAnswers((v) => ({ ...v, [q.id]: e.target.value }))
                }
              />
            </label>
          )}
          {q.isSecret && (
            <p className="muted">
              {t("Sent to the active model session when you submit. Not stored in Synora settings.")}
            </p>
          )}
        </fieldset>
      ))}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button
        className="primary"
        type="submit"
        disabled={
          pending ||
          request.params.questions.some((q) => !answers[q.id]?.trim())
        }
      >
        {pending ? t("Sending answer…") : t("Send answer")}
      </button>
    </form>
  );
}
