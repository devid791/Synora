import { z } from "zod";
import { bearerHeaders } from "./axiom-auth";
import type { ModelCapabilities } from "../shared/contracts";

// Primary contracts checked 2026-09-09: /api/endpoint/models,
// /studio/conversations/reasoning, /models/mistral-small-4-0-26-03,
// /models/mistral-medium-3-5-26-04 at https://docs.mistral.ai.
export function mistralEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.href.replace(/\/$/, "") === "https://api.mistral.ai/v1" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
        u.pathname.replace(/\/$/, "") === "/v1")
    )
  )
    throw Error(
      "Mistral requires its official HTTPS endpoint (HTTP loopback is only for isolated qualification)",
    );
  return u.href.replace(/\/$/, "");
}

const card = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  description: z.string().nullish(),
  max_context_length: z.number().int().safe().nonnegative().nullish(),
  aliases: z.array(z.string().min(1)).optional(),
  archived: z.boolean().optional(),
  capabilities: z.object({
    completion_chat: z.boolean(),
    function_calling: z.boolean(),
    vision: z.boolean().optional(),
  }),
});
// An API-wide enum is NOT evidence of per-model effort support. Only these
// documented identities (or aliases supplied by the authenticated catalog) qualify.
const adjustable = new Set([
  "mistral-small-latest",
  "mistral-small-2603",
  "mistral-medium-3-5",
]);
export async function mistralModels(
  endpoint: string,
  token?: string,
): Promise<ModelCapabilities[]> {
  endpoint = mistralEndpoint(endpoint);
  if (!token) throw Error("Save your own Mistral API key first");
  const response = await fetch(`${endpoint}/models`, {
    headers: bearerHeaders(endpoint, token),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Mistral catalog returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Mistral catalog has no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024)
        throw Error("Mistral catalog exceeds transport memory bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const page = z
    .object({ data: z.array(card) })
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
  const ids = new Set<string>();
  return page.data.map((m) => {
    if (ids.has(m.id)) throw Error("Duplicate Mistral model identity");
    ids.add(m.id);
    const aliases = m.aliases ?? [],
      reasoning = [m.id, ...aliases].some((id) => adjustable.has(id));
    const reason = m.archived
      ? "Model is archived"
      : !m.capabilities.completion_chat
        ? "Model does not support chat completions"
        : !m.capabilities.function_calling
          ? "Model does not support function calling required by Core"
          : !m.max_context_length
            ? "Model lacks an authoritative context limit"
            : undefined;
    return {
      id: m.id,
      context_window: m.max_context_length || null,
      context_window_options: [],
      reasoning_efforts: reasoning ? ["none", "high"] : [],
      ...(reasoning ? { default_reasoning_effort: "none" } : {}),
      ...(reason ? { unavailableReason: reason } : {}),
      providerModel: {
        provider: "mistral",
        aliases,
        inputModalities: m.capabilities.vision ? ["text", "image"] : ["text"],
        description: `${m.name ?? m.id} · authenticated Mistral catalog${m.description ? ` · ${m.description}` : ""}`,
        mistral: { functionCalling: m.capabilities.function_calling },
      },
    };
  });
}
export function validateMistralSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const model = models.find((m) => m.id === id);
  if (!model || model.providerModel?.provider !== "mistral")
    throw Error("Selected model is not in the authenticated Mistral catalog");
  if (model.unavailableReason) throw Error(model.unavailableReason);
  if (effort && !model.reasoning_efforts.includes(effort))
    throw Error(
      "Selected reasoning effort is not documented for this Mistral model",
    );
  return model;
}
