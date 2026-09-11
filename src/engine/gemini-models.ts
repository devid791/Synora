import { z } from "zod";
import { bearerHeaders } from "./axiom-auth";
import type { ModelCapabilities } from "../shared/contracts";
export function geminiEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !(
      u.href.replace(/\/$/, "") ===
        "https://generativelanguage.googleapis.com/v1beta" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
        u.pathname.replace(/\/$/, "") === "/v1beta")
    )
  )
    throw Error(
      "Gemini requires its official HTTPS endpoint (HTTP loopback is only for isolated qualification)",
    );
  return u.href.replace(/\/$/, "");
}
export function geminiKeyHeaders(endpoint: string, token?: string) {
  if (!token) throw Error("Save your own Gemini API key first");
  bearerHeaders(geminiEndpoint(endpoint), token);
  return { "x-goog-api-key": token };
}
export type GeminiAuthorization = (
  signal: AbortSignal,
) => Promise<{ accessToken: string; quotaProject: string }>;
export async function geminiOAuthHeaders(
  endpoint: string,
  resolve: GeminiAuthorization,
  signal: AbortSignal,
) {
  const grant = await resolve(signal);
  if (
    !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/.test(grant.quotaProject)
  )
    throw Error("Invalid Google quota project");
  signal.throwIfAborted();
  return {
    ...bearerHeaders(geminiEndpoint(endpoint), grant.accessToken),
    "x-goog-user-project": grant.quotaProject,
  };
}
const entry = z.object({
  name: z.string().regex(/^models\/[A-Za-z0-9_.-]+$/),
  displayName: z.string().optional(),
  description: z.string().optional(),
  inputTokenLimit: z.number().int().nonnegative().safe().optional(),
  outputTokenLimit: z.number().int().nonnegative().safe().optional(),
  supportedGenerationMethods: z.array(z.string()),
  thinking: z.boolean().optional(),
  maxTemperature: z.number().nonnegative().optional(),
});
const pageSchema = z.object({
  models: z.array(entry).default([]),
  nextPageToken: z.string().optional(),
});
export async function geminiModels(
  endpoint: string,
  token?: string,
  oauth?: GeminiAuthorization,
): Promise<ModelCapabilities[]> {
  endpoint = geminiEndpoint(endpoint);
  const signal = AbortSignal.timeout(15000);
  const models: ModelCapabilities[] = [],
    ids = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | undefined;
  for (let n = 0; ; n++) {
    if (n >= 100) throw Error("Gemini catalog pagination did not terminate");
    const url = new URL(`${endpoint}/models`);
    url.searchParams.set("pageSize", "1000");
    if (cursor) url.searchParams.set("pageToken", cursor);
    const headers = oauth
      ? await geminiOAuthHeaders(endpoint, oauth, signal)
      : geminiKeyHeaders(endpoint, token);
    const response = await fetch(url, { headers, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`Gemini catalog returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error("Gemini catalog has no body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024)
          throw Error("Gemini catalog exceeds transport memory bound");
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
    for (const m of page.models) {
      if (ids.has(m.name)) throw Error("Duplicate Gemini model identity");
      ids.add(m.name);
      models.push({
        id: m.name.slice(7),
        context_window: m.inputTokenLimit || null,
        context_window_options: [],
        reasoning_efforts: [],
        ...(!m.supportedGenerationMethods.includes("generateContent")
          ? { unavailableReason: "Model does not support generateContent" }
          : !m.inputTokenLimit || !m.outputTokenLimit
            ? {
                unavailableReason:
                  "Model lacks authoritative input/output limits",
              }
            : {}),
        providerModel: {
          provider: "gemini",
          aliases: [],
          inputModalities: ["text"],
          description: `${m.displayName ?? m.name} · authenticated Gemini catalog; automatic native thinking where supported. Catalog does not enumerate per-model effort levels or modalities.`,
          gemini: {
            maxOutput: m.outputTokenLimit ?? 0,
            thinking: m.thinking ?? false,
            ...(m.maxTemperature === undefined
              ? {}
              : { maxTemperature: m.maxTemperature }),
          },
        },
      });
    }
    if (!page.nextPageToken) return models;
    if (!page.models.length || cursors.has(page.nextPageToken))
      throw Error("Invalid Gemini catalog cursor");
    cursor = page.nextPageToken;
    cursors.add(cursor);
  }
}
export function validateGeminiSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const m = models.find((x) => x.id === id);
  if (!m)
    throw Error("Selected model is not in the authenticated Gemini catalog");
  if (m.unavailableReason) throw Error(m.unavailableReason);
  if (effort)
    throw Error(
      "This catalog does not enumerate per-model Gemini thinking levels; use the native automatic setting",
    );
  return m;
}
