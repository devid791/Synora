/** Codex 0.154.0 adds an optional list of decisions to command approvals.
 * Never turn approval-once into a session/policy grant, or offer a decision the
 * original server did not advertise. Older Core's absent/null list is unchanged. */
export function commandDecisionAllowed(
  params: unknown,
  decision: "accept" | "decline",
) {
  if (!params || typeof params !== "object") return false;
  const choices = (params as { availableDecisions?: unknown })
    .availableDecisions;
  return (
    choices == null || (Array.isArray(choices) && choices.includes(decision))
  );
}
/** Original currentTime/read schema: threadId string, response whole Unix seconds.
 * The live host supplies the owning thread set; the renderer cannot forge it. */
export function coreClockResponse(
  params: unknown,
  threadIds: ReadonlySet<string>,
  now = Date.now(),
) {
  const threadId =
    params && typeof params === "object"
      ? (params as { threadId?: unknown }).threadId
      : undefined;
  if (typeof threadId !== "string" || !threadIds.has(threadId))
    return {
      error: {
        code: -32602,
        message: "Clock request does not belong to an owned Synora thread",
      },
    };
  return { result: { currentTimeAt: Math.floor(now / 1000) } };
}

/** New 0.154 device-bound authentication cannot be replaced by an approval
 * checkbox. Return an explicit RPC error instead of crashing the stream parser
 * or fabricating cryptographic proof. Normal MCP tools/OAuth are unaffected. */
export function deviceVerificationError(
  params: unknown,
  threadIds: ReadonlySet<string>,
) {
  const p = params as Record<string, unknown> | null;
  const owned =
    !!p && typeof p.threadId === "string" && threadIds.has(p.threadId);
  return {
    error: {
      code: owned ? -32601 : -32602,
      message: owned
        ? "Synora does not provide OpenAI device-bound user verification. Complete this device authentication in a supported OpenAI client; no approval proof was sent."
        : "Device verification does not belong to an owned Synora thread",
    },
  };
}
