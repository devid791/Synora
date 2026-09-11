import { z } from "zod";
import type { ServerNotification } from "../protocol/codex-0.153.4/ServerNotification";

export const compactionSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    status: z.enum([
      "running",
      "completed",
      "failed",
      "interrupted",
      "unknown",
    ]),
    startedAt: z.number().finite().nonnegative(),
    completedAt: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type CompactionRecord = z.infer<typeof compactionSchema>;

/** Acknowledgement is not completion. Only Core lifecycle events establish it. */
export function updateCompactions(
  records: CompactionRecord[],
  event: ServerNotification,
  at: number,
): CompactionRecord[] {
  if (
    (event.method === "item/started" || event.method === "item/completed") &&
    event.params.item.type === "contextCompaction"
  ) {
    const p = event.params,
      done = event.method === "item/completed";
    const old = records.find(
      (r) =>
        r.id === p.item.id &&
        r.threadId === p.threadId &&
        r.turnId === p.turnId,
    );
    if (old && old.status !== "running") return records;
    const record: CompactionRecord = {
      id: p.item.id,
      threadId: p.threadId,
      turnId: p.turnId,
      status: done ? "completed" : "running",
      startedAt: old?.startedAt ?? at,
      ...(done ? { completedAt: at } : {}),
    };
    return [...records.filter((r) => r !== old), record];
  }
  if (
    event.method === "turn/completed" &&
    event.params.turn.status !== "inProgress"
  ) {
    const { threadId, turn } = event.params;
    return records.map((r) =>
      r.threadId === threadId && r.turnId === turn.id && r.status === "running"
        ? {
            ...r,
            completedAt: at,
            status:
              turn.status === "failed"
                ? "failed"
                : turn.status === "interrupted"
                  ? "interrupted"
                  : "unknown",
          }
        : r,
    );
  }
  return records;
}
