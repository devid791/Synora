import type { Conversation } from "./contracts";
type Message = Conversation["messages"][number];

/** Preserve received partial output when Core's cold history omits its text. */
export function mergeMessage(
  previous: Message | undefined,
  incoming: Message,
  source: "started" | "completed" | "history" | "interrupted",
): Message {
  if (incoming.role !== "assistant") return incoming;
  if (source === "completed") return { ...incoming, incomplete: false };
  if (source === "started" && previous) return previous;
  const retain =
    source === "history" &&
    previous?.incomplete &&
    previous.text.length > incoming.text.length &&
    previous.text.startsWith(incoming.text);
  return {
    ...incoming,
    text: retain ? previous.text : incoming.text,
    incomplete:
      source === "history"
        ? (previous?.incomplete ?? false)
        : source === "started" ||
          !previous ||
          previous.incomplete === true ||
          previous.text !== incoming.text,
  };
}
