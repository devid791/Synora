import { useId } from "react";
import { ArrowUp, ListPlus, X } from "lucide-react";
import type { QueuedMessage } from "../shared/user-preferences";
import { useI18n } from "./i18n";
import { messages } from "./locales/settings";

export function BusyMessageStatus({
  queue = [],
  behavior,
  available,
  pending,
  canSubmit,
  submit,
  submitted,
  removing,
  removingId,
  remove,
  addToDraft,
  focusDraft,
}: {
  queue?: QueuedMessage[];
  behavior: "queue" | "steer";
  available: boolean;
  pending: boolean;
  canSubmit: boolean;
  submit: (behavior: "queue" | "steer") => void;
  submitted: "queue" | "steer" | null;
  removing: boolean;
  removingId: string | null;
  remove: (messageId: string) => Promise<void>;
  addToDraft: (text: string) => void;
  focusDraft: () => void;
}) {
  const { t } = useI18n(messages);
  const id = useId();
  return (
    <>
      {(available || pending) && (
        <div className="busy-message-actions">
          <button
            type="button"
            className="busy-send-now"
            disabled={!canSubmit || pending}
            title={t(
              "Send to the active turn without waiting for it to finish.",
            )}
            onClick={() => submit("steer")}
          >
            <ArrowUp aria-hidden="true" />
            {t("Send now")}
          </button>
          <button
            type="button"
            disabled={!canSubmit || pending}
            title={t("Send after the current turn finishes.")}
            onClick={() => submit("queue")}
          >
            <ListPlus aria-hidden="true" />
            {t("Queue")}
          </button>
        </div>
      )}
      {submitted && !pending && (
        <p className="busy-message-receipt" role="status">
          {submitted === "steer"
            ? t("Sent to the active turn.")
            : t("Queued — after the current turn")}
        </p>
      )}
      {queue.length > 0 && (
        <section className="queued-messages" aria-label={t("Queued messages")}>
          {queue.map((message) => (
            <div
              key={message.id}
              className="queued-message"
              data-queue-status={message.status}
              data-queued-message-id={message.id}
            >
              <div className="queued-message-heading">
                <strong id={`${id}-${message.id}-status`}>
                  {message.status === "held"
                    ? t("Held for review — not sent automatically")
                    : message.status === "dispatching"
                      ? t("Sending queued message…")
                      : t("Queued — after the current turn")}
                </strong>
                <div className="queued-message-actions">
                  {message.status === "held" && (
                    <button
                      type="button"
                      disabled={removing}
                      aria-label={t("Add held message to draft")}
                      aria-describedby={`${id}-${message.id}-text`}
                      onClick={() => {
                        addToDraft(message.text);
                        focusDraft();
                      }}
                    >
                      {t("Add to draft")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="remove-queued-message"
                    aria-label={t("Remove queued message")}
                    aria-describedby={`${id}-${message.id}-status ${id}-${message.id}-text`}
                    disabled={removing || message.status === "dispatching"}
                    title={
                      message.status === "dispatching"
                        ? t(
                            "This message is already being sent and cannot be removed.",
                          )
                        : t(
                            "Remove only this queued message. Your draft is kept.",
                          )
                    }
                    onClick={async (event) => {
                      const button = event.currentTarget;
                      try {
                        await remove(message.id);
                        requestAnimationFrame(() => {
                          // Do not steal focus if the user navigated or focused
                          // another control while the service acknowledged removal.
                          if (
                            !button.isConnected &&
                            document.activeElement === document.body
                          )
                            focusDraft();
                        });
                      } catch {
                        /* App retains and displays the service failure. */
                      }
                    }}
                  >
                    <X aria-hidden="true" />
                    {t("Remove")}
                  </button>
                </div>
              </div>
              <p id={`${id}-${message.id}-text`}>{message.text}</p>
              {removingId === message.id && (
                <p role="status">{t("Removing queued message…")}</p>
              )}
            </div>
          ))}
        </section>
      )}
      {(available || pending) && (
        <p className="busy-message-status" role="status">
          {pending
            ? t("Submitting message…")
            : behavior === "queue"
              ? t(
                  "Enter queues your text. Cmd/Ctrl+Enter steers the active turn. Shift+Enter adds a new line.",
                )
              : t(
                  "Enter steers the active turn. Cmd/Ctrl+Enter queues your text. Shift+Enter adds a new line.",
                )}
        </p>
      )}
    </>
  );
}
