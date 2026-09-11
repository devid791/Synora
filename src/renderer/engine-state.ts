import type { EngineSnapshot, EventEnvelope } from "../shared/contracts";
import { updateItems } from "../shared/item-state";
import { updateCompactions } from "../shared/compaction";
export const emptyEngine: EngineSnapshot = {
  connection: "simulated",
  threadId: null,
  turnId: null,
  status: "idle",
  items: [],
  agents: [],
  approval: null,
  sequence: 0,
};
export function reduceEngine(
  state: EngineSnapshot,
  envelope: EventEnvelope,
): EngineSnapshot {
  if (envelope.sequence <= state.sequence) return state;
  const next = { ...state, sequence: envelope.sequence },
    e = envelope.event;
  if (e.kind === "snapshot")
    return { ...e.snapshot, sequence: envelope.sequence };
  if (e.kind === "history") return next;
  if (e.kind === "backend-metrics")
    return {
      ...next,
      backendRequests: [
        ...(next.backendRequests ?? []).filter(
          (v) => v.responseId !== e.metrics.responseId,
        ),
        e.metrics,
      ],
    };
  if (e.kind === "connection")
    return {
      ...next,
      connection: e.state,
      ...(e.appServer ? { appServer: e.appServer } : {}),
    };
  if (e.kind === "agents") return { ...next, agents: e.agents };
  if (e.kind === "approval")
    return {
      ...next,
      conversationId: envelope.conversationId ?? e.params.threadId,
      status: "waiting",
      approval: { id: e.id, params: e.params },
    };
  const { method, params } = e.payload;
  if (
    "threadId" in params &&
    next.threadId &&
    params.threadId !== next.threadId
  )
    return next;
  if ("turnId" in params && params.turnId !== next.turnId) return next;
  if (method === "turn/completed" && params.turn.id !== next.turnId)
    return next;
  next.compactions = updateCompactions(
    next.compactions ?? [],
    e.payload,
    envelope.at,
  );
  if (method === "turn/started")
    return {
      ...next,
      conversationId: envelope.conversationId ?? params.threadId,
      threadId: params.threadId,
      turnId: params.turn.id,
      status: "running",
      startedAt: envelope.at,
      firstDeltaAt: undefined,
      completedAt: undefined,
      // Keep last reported context/cumulative usage while the next request runs.
      // The owning engine clears these on an actual conversation change.
      tokenUsage: next.tokenUsage,
      items: params.turn.items,
      agents: [],
      approval: null,
    };
  if (method === "turn/completed")
    return {
      ...next,
      threadId: params.threadId,
      turnId: params.turn.id,
      status:
        params.turn.status === "inProgress" ? "running" : params.turn.status,
      items: [
        ...new Map(
          [...next.items, ...params.turn.items].map((i) => [i.id, i]),
        ).values(),
      ],
      approval: null,
      completedAt: envelope.at,
    };
  if (method === "thread/tokenUsage/updated")
    return { ...next, tokenUsage: params.tokenUsage };
  if (method === "item/agentMessage/delta") next.firstDeltaAt ??= envelope.at;
  return { ...next, items: updateItems(next.items, e.payload) };
}
