import { z } from "zod";
import type { prepareAxiomProcess } from "./axiom-process";
import { bearerHeaders } from "./axiom-auth";
import { ResponsesToolCodec } from "./responses-tool-codec";
import type { ModelCapabilities } from "../shared/contracts";
import {
  ProviderCompatibilityError,
  responsesBridge,
  prepareResponsesProcess,
  PROVIDER_TOKEN_HEADER,
  PROVIDER_TOKEN_ENV,
} from "./responses-provider";
export class XaiCompatibilityError extends ProviderCompatibilityError {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super("XAI_COMPATIBILITY", path, reason);
  }
}
const fail = (path: string, reason: string): never => {
  throw new XaiCompatibilityError(path, reason);
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function xaiEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname.replace(/\/$/, "") !== "/v1" ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
    )
  )
    throw Error(
      "xAI requires HTTPS /v1 without URL credentials, query or fragment (HTTP is allowed only on loopback)",
    );
  return u.href.replace(/\/$/, "");
}

// Published model capabilities, separate from the authenticated access catalog.
// Exact documented identities/aliases only; never infer future-model capabilities.
// https://docs.x.ai/developers/models and model-capabilities/text/reasoning
const documented: Record<string, { context: number; efforts: string[] }> = {
  "grok-4.6": { context: 500000, efforts: ["low", "medium", "high", "xhigh"] },
  "grok-4.5": { context: 500000, efforts: ["low", "medium", "high"] },
  "grok-4.3": { context: 1000000, efforts: [] },
  "grok-4.20-0309-reasoning": { context: 1000000, efforts: [] },
  "grok-4.20-0309-non-reasoning": { context: 1000000, efforts: [] },
  "grok-build-0.1": { context: 256000, efforts: [] },
};
const languageCatalog = z.object({
  models: z
    .array(
      z
        .object({
          id: z.string().min(1).max(256),
          aliases: z.array(z.string().min(1).max(256)).default([]),
          input_modalities: z.array(z.string()).nonempty(),
          output_modalities: z.array(z.string()).nonempty(),
        })
        .passthrough(),
    )
    .nonempty(),
});

async function jsonBytes(response: Response, bound = 2 * 1024 * 1024) {
  if (!response.body) throw Error("xAI returned no response body");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (Number(response.headers.get("content-length")) > bound)
      throw Error("xAI response exceeds transport memory bound");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bound)
        throw Error("xAI response exceeds transport memory bound");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } finally {
    await reader.cancel();
  }
}
export async function xaiModels(
  endpoint: string,
  token?: string,
): Promise<ModelCapabilities[]> {
  if (!token) throw Error("Save an xAI API key for this endpoint first");
  const response = await fetch(`${xaiEndpoint(endpoint)}/language-models`, {
    headers: bearerHeaders(endpoint, token),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`xAI model catalog returned HTTP ${response.status}`);
  }
  const raw = languageCatalog.parse(await jsonBytes(response));
  const ids = new Set<string>();
  return raw.models.map((m) => {
    if (ids.has(m.id)) throw Error("xAI returned duplicate model identities");
    ids.add(m.id);
    const matches = [m.id, ...m.aliases].flatMap((id) =>
      Object.hasOwn(documented, id) ? [documented[id]] : [],
    );
    if (matches.some((v) => JSON.stringify(v) !== JSON.stringify(matches[0])))
      throw Error(
        `xAI model ${m.id} has conflicting documented capability aliases`,
      );
    const caps = matches[0];
    const unavailableReason =
      !m.input_modalities.includes("text") ||
      !m.output_modalities.includes("text")
        ? "This model is not a text Responses model"
        : !caps
          ? "Model is available to this key, but its context/tool capabilities need qualification in this Synora adapter"
          : undefined;
    return {
      id: m.id,
      context_window: caps?.context ?? null,
      context_window_options: [],
      reasoning_efforts: caps?.efforts ?? [],
      ...(caps?.efforts.length ? { default_reasoning_effort: "high" } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
      providerModel: {
        provider: "xai" as const,
        aliases: m.aliases,
        inputModalities: m.input_modalities,
        description:
          "xAI authenticated language catalog; context/effort from documented model capabilities, not an inference qualification",
      },
    };
  });
}
export function validateXaiSelection(
  models: ModelCapabilities[],
  model: string,
  effort?: string,
) {
  const selected = models.find((v) => v.id === model);
  if (!selected)
    throw Error("Selected model is not advertised by this xAI account");
  if (selected.unavailableReason) throw Error(selected.unavailableReason);
  if (effort && !selected.reasoning_efforts.includes(effort))
    throw Error("Selected reasoning effort is not supported by this xAI model");
  return selected;
}

/** Request-local translation, with original non-model metadata retained privately.
 * No instructions, history, tool result or call identity is summarized or removed.
 */
export class XaiEnvelope {
  readonly tools = new ResponsesToolCodec();
  readonly metadata: { path: string; value: unknown }[] = [];
  constructor(private model: ModelCapabilities) {}
  request(raw: Buffer) {
    let source: unknown;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return fail("$", "Expected valid UTF-8 JSON");
    }
    if (!object(source)) return fail("$", "Expected a request object");
    if (source.model !== this.model.id)
      return fail("$.model", "Request differs from selected model");
    const allowed = [
      "model",
      "input",
      "instructions",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "reasoning",
      "store",
      "stream",
      "include",
      "prompt_cache_key",
      "text",
      "client_metadata",
      "max_output_tokens",
      "temperature",
      "top_p",
      "user",
      "metadata",
      "truncation",
      "background",
    ];
    for (const k of Object.keys(source))
      if (!allowed.includes(k))
        fail(`$.${k}`, "No verified xAI mapping for this Core request field");
    if (source.stream !== true)
      fail("$.stream", "The Synora Core adapter requires streaming Responses");
    if (source.store !== false)
      fail(
        "$.store",
        "Synora owns history; provider-side storage must remain false",
      );
    if (source.background !== undefined && source.background !== false)
      fail("$.background", "xAI does not implement background mode");
    if (source.truncation !== undefined && source.truncation !== "disabled")
      fail("$.truncation", "xAI does not implement requested truncation");
    if (
      source.instructions !== undefined &&
      typeof source.instructions !== "string"
    )
      fail("$.instructions", "Expected original instructions text");
    if (source.client_metadata !== undefined && !object(source.client_metadata))
      fail("$.client_metadata", "Expected Core metadata object");
    const body = this.tools.request(source);
    const retain = (
      obj: Record<string, unknown>,
      key: string,
      path: string,
    ) => {
      if (Object.hasOwn(obj, key)) {
        this.metadata.push({ path, value: obj[key] });
        delete obj[key];
      }
    };
    retain(body, "client_metadata", "$.client_metadata");
    if (!Array.isArray(body.input))
      return fail("$.input", "Expected full Core input history");
    body.input.forEach((item: unknown, i: number) => {
      const path = `$.input[${i}]`;
      if (!object(item)) return fail(path, "Expected an input object");
      const type = item.type ?? "message";
      const keys: Record<string, string[]> = {
        message: [
          "type",
          "id",
          "role",
          "content",
          "status",
          "phase",
          "internal_chat_message_metadata_passthrough",
        ],
        function_call: ["type", "id", "call_id", "name", "arguments", "status"],
        function_call_output: ["type", "id", "call_id", "output", "status"],
        reasoning: [
          "type",
          "id",
          "summary",
          "content",
          "encrypted_content",
          "status",
        ],
        compaction: ["type", "id", "encrypted_content"],
      };
      if (typeof type !== "string" || !Object.hasOwn(keys, type))
        fail(`${path}.type`, "Unsupported input item; history was not dropped");
      for (const k of Object.keys(item))
        if (!keys[type as string].includes(k))
          fail(`${path}.${k}`, "Unsupported input item property");
      if (type === "message") {
        retain(
          item,
          "internal_chat_message_metadata_passthrough",
          `${path}.internal_chat_message_metadata_passthrough`,
        );
        // Core-only presentation phase; all assistant text and its identity stay intact.
        retain(item, "phase", `${path}.phase`);
      }
    });
    if (body.text !== undefined) {
      if (!object(body.text)) fail("$.text", "Expected text configuration");
      for (const k of Object.keys(body.text as object))
        if (k !== "format")
          fail(
            `$.text.${k}`,
            "xAI only documents text.format; no verbosity override was applied",
          );
    }
    if (body.reasoning !== undefined) {
      if (!object(body.reasoning))
        fail("$.reasoning", "Expected reasoning configuration");
      const r = body.reasoning as Record<string, unknown>;
      for (const k of Object.keys(r))
        if (!["effort", "summary", "generate_summary"].includes(k))
          fail(`$.reasoning.${k}`, "Unsupported reasoning property");
      if (
        r.effort != null &&
        (typeof r.effort !== "string" ||
          !this.model.reasoning_efforts.includes(r.effort))
      )
        fail(
          "$.reasoning.effort",
          "Effort is not documented for the selected model",
        );
    }
    if (
      body.include !== undefined &&
      (!Array.isArray(body.include) ||
        body.include.some((v) => v !== "reasoning.encrypted_content"))
    )
      fail(
        "$.include",
        "Requested extra output is not qualified by this adapter",
      );
    return Buffer.from(JSON.stringify(body));
  }
}

export const XAI_TOKEN_HEADER = PROVIDER_TOKEN_HEADER;
export const XAI_TOKEN_ENV = PROVIDER_TOKEN_ENV;
export function xaiBridge(
  options: Omit<
    Parameters<typeof responsesBridge>[0],
    "label" | "errorPrefix" | "envelope"
  > & { model: ModelCapabilities },
) {
  return responsesBridge({
    ...options,
    endpoint: xaiEndpoint(options.endpoint),
    label: "xAI",
    errorPrefix: "XAI",
    envelope: () => new XaiEnvelope(options.model),
  });
}
export const prepareXaiProcess: typeof prepareAxiomProcess = (options) =>
  prepareResponsesProcess(options, {
    id: "synora_xai",
    name: "xAI",
    models: xaiModels,
    validate: validateXaiSelection,
    bridge: xaiBridge,
  });
