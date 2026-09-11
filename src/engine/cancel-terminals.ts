import { parseResponse } from "./protocol-validation";
import type { ThreadItem } from "../protocol/codex-0.153.4/v2/ThreadItem";

/** Core process IDs are opaque, not OS PIDs. Never use thread-wide clean here. */
export async function cancelTurnTerminals(
  transport: {
    request(
      method: string,
      params: unknown,
      timeoutMs?: number,
    ): Promise<unknown>;
  },
  threadId: string,
  commands: () => ThreadItem[],
  deadline: number,
): Promise<void> {
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0)
      throw Error("Cancelled turn command cleanup exceeded its deadline");
    return ms;
  };
  for (;;) {
    const owned = new Map(
      commands()
        .filter((i) => i.type === "commandExecution")
        .map((i) => [i.id, i.processId]),
    );
    const targets = new Map<string, string>();
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = parseResponse(
        "terminals",
        await transport.request(
          "thread/backgroundTerminals/list",
          { threadId, ...(cursor ? { cursor } : {}) },
          remaining(),
        ),
      );
      for (const terminal of page.data) {
        if (!owned.has(terminal.itemId)) continue;
        const expected = owned.get(terminal.itemId);
        if (
          !terminal.processId ||
          (expected != null && expected !== terminal.processId)
        )
          throw Error(
            `Cancelled turn command identity mismatch: ${terminal.itemId}`,
          );
        const previous = targets.get(terminal.processId);
        if (previous && previous !== terminal.itemId)
          throw Error(
            "App Server returned a conflicting background process identity",
          );
        targets.set(terminal.processId, terminal.itemId);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seen.has(cursor))
          throw Error("Background terminal inventory repeated its cursor");
        seen.add(cursor);
      }
    } while (cursor);
    if (!targets.size) return;
    for (const processId of targets.keys()) {
      // false is allowed only for an exit race: the next full inventory must
      // confirm absence. Neither true nor false alone is a cleanup receipt.
      parseResponse(
        "terminate",
        await transport.request(
          "thread/backgroundTerminals/terminate",
          { threadId, processId },
          remaining(),
        ),
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(25, remaining())),
    );
  }
}
