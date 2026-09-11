import type { Conversation, EngineSnapshot } from "../shared/contracts";
import { mergeMessage } from "../shared/message-history";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
type Entry =
  | { type: "message"; id: string; message: Conversation["messages"][number] }
  | { type: "tool"; id: string; item: ThreadItem; simulated: boolean };
export function conversationTimeline(
  conversation: Conversation | undefined,
  engine: EngineSnapshot,
): Entry[] {
  if (!conversation) return [];
  const entries = new Map<string, Entry>();
  for (const message of conversation.messages)
    entries.set(message.id, { type: "message", id: message.id, message });
  for (const item of conversation.activity)
    entries.set(item.id, {
      type: "tool",
      id: item.id,
      item,
      simulated: !conversation.binding,
    });
  const active = (engine.conversationId ?? engine.threadId) === conversation.id;
  const items = active ? engine.items : [];
  for (const item of items) {
    if (item.type === "agentMessage" || item.type === "userMessage") {
      const message = {
        id: item.id,
        imageIds:
          conversation.messages.find((m) => m.id === item.id)?.imageIds ?? [],
        role:
          item.type === "agentMessage"
            ? ("assistant" as const)
            : ("user" as const),
        text:
          item.type === "agentMessage"
            ? item.text
            : item.content
                .flatMap((v) => (v.type === "text" ? [v.text] : []))
                .join("\n"),
        simulated: !conversation.binding,
      };
      const previous = conversation.messages.find((m) => m.id === item.id);
      const merged = mergeMessage(previous, message, "history");
      entries.set(item.id, { type: "message", id: item.id, message: merged });
    } else
      entries.set(item.id, {
        type: "tool",
        id: item.id,
        item,
        simulated: !conversation.binding,
      });
  }
  const order = [
    ...new Set([
      ...conversation.itemOrder,
      ...items.map((i) => i.id),
      ...entries.keys(),
    ]),
  ];
  return order.flatMap((id) => (entries.has(id) ? [entries.get(id)!] : []));
}
