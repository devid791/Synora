import { z } from "zod";
import { bearerHeaders } from "./axiom-auth";
import type { ModelCapabilities } from "../shared/contracts";
export const ANTHROPIC_VERSION = "2023-06-01";
export function anthropicEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.href.replace(/\/$/, "") === "https://api.anthropic.com/v1" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
        url.pathname.replace(/\/$/, "") === "/v1")
    )
  )
    throw Error(
      "Anthropic requires its official HTTPS endpoint (HTTP loopback is only for isolated qualification)",
    );
  return url.href.replace(/\/$/, "");
}
const support = z.object({ supported: z.boolean() });
const modelSchema = z.object({
  id: z.string().min(1).max(512),
  type: z.literal("model"),
  display_name: z.string(),
  max_input_tokens: z.number().int().nonnegative().safe().nullable(),
  max_tokens: z.number().int().nonnegative().safe().nullable(),
  capabilities: z
    .object({
      image_input: support,
      structured_outputs: support,
      effort: z.object({
        supported: z.boolean(),
        low: support,
        medium: support,
        high: support,
        xhigh: support.nullish(),
        max: support,
      }),
      thinking: z.object({
        supported: z.boolean(),
        types: z.object({ adaptive: support, enabled: support }),
      }),
    })
    .nullable(),
});
const pageSchema = z.object({
  data: z.array(modelSchema),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});
export async function anthropicModels(
  endpoint: string,
  token?: string,
): Promise<ModelCapabilities[]> {
  endpoint = anthropicEndpoint(endpoint);
  if (!token) throw Error("Save your own Claude API credential first");
  const headers = {
    ...bearerHeaders(endpoint, token),
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const signal = AbortSignal.timeout(15000),
    cursors = new Set<string>(),
    ids = new Set<string>();
  const models: ModelCapabilities[] = [];
  let cursor: string | undefined;
  for (let n = 0; ; n++) {
    if (n >= 100) throw Error("Anthropic model pagination did not terminate");
    const url = new URL(`${endpoint}/models`);
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("after_id", cursor);
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Anthropic catalog returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("Anthropic catalog has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024)
          throw Error("Anthropic catalog exceeds transport memory bound");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const page = pageSchema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
    for (const m of page.data) {
      if (ids.has(m.id))
        throw Error("Anthropic catalog has duplicate model identities");
      ids.add(m.id);
      const c = m.capabilities;
      const efforts = c?.effort.supported
        ? (["low", "medium", "high", "xhigh", "max"] as const).filter(
            (e) => c.effort[e]?.supported,
          )
        : [];
      models.push({
        id: m.id,
        context_window: m.max_input_tokens || null,
        context_window_options: [],
        reasoning_efforts: efforts,
        ...(efforts.includes("high")
          ? { default_reasoning_effort: "high" }
          : {}),
        ...(!m.max_input_tokens || !m.max_tokens || !c
          ? {
              unavailableReason:
                "Model lacks authoritative context/output/capability metadata",
            }
          : {}),
        providerModel: {
          provider: "anthropic",
          aliases: [],
          inputModalities: c?.image_input.supported
            ? ["text", "image"]
            : ["text"],
          description: `${m.display_name} · authenticated Claude catalog; metadata is not inference qualification`,
          anthropic: {
            maxOutput: m.max_tokens ?? 0,
            adaptiveThinking:
              !!c?.thinking.supported && c.thinking.types.adaptive.supported,
            structuredOutputs: !!c?.structured_outputs.supported,
          },
        },
      });
    }
    if (!page.has_more) return models;
    if (
      !page.last_id ||
      !page.data.length ||
      cursors.has(page.last_id) ||
      !page.data.some((m) => m.id === page.last_id)
    )
      throw Error("Anthropic catalog has an invalid pagination cursor");
    cursor = page.last_id;
    cursors.add(cursor);
  }
}
export function validateAnthropicSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const m = models.find((m) => m.id === id);
  if (!m)
    throw Error("Selected model is not in the authenticated Anthropic catalog");
  if (m.unavailableReason) throw Error(m.unavailableReason);
  if (effort && !m.reasoning_efforts.includes(effort))
    throw Error("Selected effort is not supported by this Anthropic model");
  return m;
}
