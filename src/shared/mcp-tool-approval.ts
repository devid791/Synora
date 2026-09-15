import type { McpServerElicitationRequestParams } from "../protocol/codex-0.153.4/v2/McpServerElicitationRequestParams";

export type McpToolApprovalParams = McpServerElicitationRequestParams & {
  mode: "form";
  turnId: string;
};
/** Original Core's tool-call consent is an empty form, not arbitrary elicitation.
 * Never invent answers for a server's form, accept URL flows or persist grants. */
export function isMcpToolApproval(value: unknown): value is McpToolApprovalParams {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, any>, schema = p.requestedSchema;
  return p.mode === "form" && typeof p.threadId === "string" && !!p.threadId &&
    typeof p.turnId === "string" && !!p.turnId && typeof p.serverName === "string" && !!p.serverName &&
    typeof p.message === "string" && p._meta?.codex_approval_kind === "mcp_tool_call" &&
    schema?.type === "object" && !!schema.properties && typeof schema.properties === "object" &&
    !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every(k => ["type", "properties", "required", "additionalProperties", "title", "description"].includes(k)) &&
    (schema.additionalProperties === undefined || schema.additionalProperties === false);
}
