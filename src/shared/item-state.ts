import type { ServerNotification } from "../protocol/codex-0.153.4/ServerNotification";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";
/** One immutable item reducer for replay, native UI and the live backend. */
export function updateItems(
  items: ThreadItem[],
  n: ServerNotification,
): ThreadItem[] {
  if (n.method === "item/started" || n.method === "item/completed") {
    const item = structuredClone(n.params.item),
      index = items.findIndex((i) => i.id === item.id);
    if (index < 0) return [...items, item];
    return items.map((v, i) => (i === index ? item : v));
  }
  if (
    n.method === "item/agentMessage/delta" ||
    n.method === "item/plan/delta" ||
    n.method === "item/commandExecution/outputDelta" ||
    n.method === "item/reasoning/textDelta" ||
    n.method === "item/reasoning/summaryTextDelta" ||
    n.method === "item/reasoning/summaryPartAdded"
  ) {
    const index = items.findIndex((i) => i.id === n.params.itemId);
    if (index < 0)
      throw new Error(`Delta references unknown item ${n.params.itemId}`);
    const item = structuredClone(items[index]);
    if (n.method === "item/agentMessage/delta" && item.type === "agentMessage")
      item.text += n.params.delta;
    else if (n.method === "item/plan/delta" && item.type === "plan")
      item.text += n.params.delta;
    else if (
      n.method === "item/commandExecution/outputDelta" &&
      item.type === "commandExecution"
    )
      item.aggregatedOutput = (item.aggregatedOutput ?? "") + n.params.delta;
    else if (item.type === "reasoning") {
      const content = n.method === "item/reasoning/textDelta";
      const part = content
        ? n.params.contentIndex
        : "summaryIndex" in n.params
          ? n.params.summaryIndex
          : -1;
      const parts = content ? item.content : item.summary;
      if (part < 0 || part > parts.length)
        throw new Error(`Invalid reasoning part ${part} for ${item.id}`);
      parts[part] =
        (parts[part] ?? "") + ("delta" in n.params ? n.params.delta : "");
    } else
      throw new Error(
        `Delta ${n.method} has an incompatible item ${item.type}`,
      );
    return items.map((v, i) => (i === index ? item : v));
  }
  return items;
}
