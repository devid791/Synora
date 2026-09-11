import { useId } from "react";
import { X } from "lucide-react";
import type { QueuedMessage } from "../shared/user-preferences";
import { useI18n } from "./i18n";
import { messages } from "./locales/settings";

export function BusyMessageStatus({
  queue = [],
  behavior,
  available,
  pending,
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
