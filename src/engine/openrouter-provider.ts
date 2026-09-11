import { z } from "zod";
import type { prepareAxiomProcess } from "./axiom-process";
import { bearerHeaders } from "./axiom-auth";
import { ResponsesToolCodec } from "./responses-tool-codec";
import {
  prepareResponsesProcess,
  responsesBridge,
  ProviderCompatibilityError,
} from "./responses-provider";
import type { ModelCapabilities } from "../shared/contracts";
import { providerDefinitions } from "../shared/provider-registry";

export function openRouterEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.href.replace(/\/$/, "") === providerDefinitions.openrouter.endpoint ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
        ["/v1", "/api/v1"].includes(url.pathname.replace(/\/$/, "")))
    )
  )
    throw Error(
      "OpenRouter requires its official HTTPS endpoint (HTTP loopback is reserved for local qualification)",
    );
  return url.href.replace(/\/$/, "");
}

const effortNames = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
];
const modelSchema = z.object({
  id: z.string().min(1).max(512),
  name: z.string().max(512).optional(),
  context_length: z.number().int().positive().safe().nullable(),
  architecture: z.object({
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
  }),
  supported_parameters: z.array(z.string()),
  top_provider: z
    .object({
      context_length: z.number().int().positive().safe().nullable().optional(),
    })
    .nullable()
    .optional(),
  reasoning: z
    .object({
      mandatory: z.boolean(),
      supported_efforts: z.array(z.string()).nullable().optional(),
      default_effort: z.string().nullable().optional(),
      default_enabled: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});
const pageSchema = z.object({
  data: z.array(modelSchema),
  links: z.object({ next: z.string().nullable() }).optional(),
});
async function catalogJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("OpenRouter returned no model catalog");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024 * 1024)
        throw Error("Model catalog exceeds transport memory bound");
      chunks.push(value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    await reader.cancel();
  }
}
/** Authenticated user/preferences catalog, not a hardcoded model allowlist. */
export async function openRouterModels(
  endpoint: string,
  token?: string,
): Promise<ModelCapabilities[]> {
  endpoint = openRouterEndpoint(endpoint);
  if (!token)
    throw Error("Save an OpenRouter API key or finish browser sign-in first");
  const url = new URL(`${endpoint}/models/user`),
    seen = new Set<string>(),
    ids = new Set<string>();
  const models: ModelCapabilities[] = [];
  let next: URL | undefined = url;
  const signal = AbortSignal.timeout(15000);
  while (next) {
    if (
      next.origin !== url.origin ||
      next.pathname !== url.pathname ||
      next.username ||
      next.password ||
      next.hash ||
      seen.has(next.href)
    )
      throw Error(
        "Invalid OpenRouter catalog pagination: origin, user scope or cursor changed",
      );
    seen.add(next.href);
    if (seen.size > 100)
      throw Error("OpenRouter model pagination did not terminate");
    const response = await fetch(next, {
      headers: bearerHeaders(endpoint, token),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error(`OpenRouter model catalog returned HTTP ${response.status}`);
    }
    const page = pageSchema.parse(await catalogJson(response));
    for (const m of page.data) {
      if (ids.has(m.id))
        throw Error("OpenRouter returned duplicate model identities");
      ids.add(m.id);
      const windows = [m.context_length, m.top_provider?.context_length].filter(
        (n): n is number => n != null,
      );
      const context = windows.length ? Math.min(...windows) : null;
      const reasoning = m.reasoning;
      const efforts = !reasoning
        ? []
        : (reasoning.supported_efforts === null
            ? effortNames
            : (reasoning.supported_efforts ?? [])
          ).filter(
            (e) =>
              effortNames.includes(e) && !(reasoning.mandatory && e === "none"),
          );
      const selectedDefault =
        reasoning?.default_enabled &&
        reasoning.default_effort &&
        reasoning.default_effort !== "none" &&
        efforts.includes(reasoning.default_effort)
          ? reasoning.default_effort
          : undefined;
      const unavailableReason =
        !m.architecture.input_modalities.includes("text") ||
        !m.architecture.output_modalities.includes("text")
          ? "This model does not provide text input/output"
          : !m.supported_parameters.includes("tools")
            ? "This model does not advertise tool calling"
            : context === null
              ? "This model does not report a usable context window"
              : undefined;
      models.push({
        id: m.id,
        context_window: context,
        context_window_options: [],
        reasoning_efforts: efforts,
        ...(selectedDefault
          ? { default_reasoning_effort: selectedDefault }
          : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
        providerModel: {
          provider: "openrouter",
          aliases: [],
          inputModalities: m.architecture.input_modalities,
          description: `${m.name ?? m.id} · OpenRouter authenticated user catalog; metadata is not inference qualification`,
        },
      });
    }
    next = page.links?.next ? new URL(page.links.next, next) : undefined;
  }
  return models;
}
export function validateOpenRouterSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const model = models.find((m) => m.id === id);
  if (!model)
    throw Error("Selected model is not in this OpenRouter user catalog");
  if (model.unavailableReason) throw Error(model.unavailableReason);
  if (effort && !model.reasoning_efforts.includes(effort))
    throw Error("Selected effort is not advertised by this OpenRouter model");
  return model;
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (path: string, reason: string): never => {
  throw new ProviderCompatibilityError(
    "OPENROUTER_COMPATIBILITY",
    path,
    reason,
  );
};
export class OpenRouterEnvelope {
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
    if (!object(source)) return fail("$", "Expected a Responses object");
    if (source.model !== this.model.id)
      fail("$.model", "Request differs from the selected model");
    for (const key of Object.keys(source))
      if (
        ![
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
          "session_id",
          "previous_response_id",
        ].includes(key)
      )
        fail(
          `$.${key}`,
          "No verified OpenRouter mapping for this Core request property",
        );
    if (source.stream !== true)
      fail("$.stream", "Original Core requires streaming Responses");
    if (source.store !== false)
      fail("$.store", "OpenRouter is stateless; Core owns full history");
    if (source.previous_response_id != null)
      fail(
        "$.previous_response_id",
        "Send full history, not provider-side references",
      );
    if (source.background != null && source.background !== false)
      fail(
        "$.background",
        "The owned Core connection requires foreground completion",
      );
    if (source.truncation != null && source.truncation !== "disabled")
      fail("$.truncation", "History must not be silently truncated upstream");
    if (source.instructions != null && typeof source.instructions !== "string")
      fail("$.instructions", "Expected instructions text");
    if (source.client_metadata != null && !object(source.client_metadata))
      fail("$.client_metadata", "Expected Core metadata object");
    const body = this.tools.request(source);
    const retain = (o: Record<string, unknown>, key: string, path: string) => {
      if (Object.hasOwn(o, key)) {
        this.metadata.push({ path, value: o[key] });
        delete o[key];
      }
    };
    retain(body, "client_metadata", "$.client_metadata");
    if (!Array.isArray(body.input))
      return fail("$.input", "Expected full Core history");
    body.input.forEach((v, i) => {
      const path = `$.input[${i}]`;
      if (!object(v)) return fail(path, "Expected input item");
      if (
        ![
          "message",
          "function_call",
          "function_call_output",
          "reasoning",
          "compaction",
        ].includes(String(v.type ?? "message"))
      )
        fail(
          `${path}.type`,
          "Unsupported item; original history was not removed",
        );
      const fields: Record<string, string[]> = {
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
          "format",
          "signature",
        ],
        compaction: ["type", "id", "encrypted_content"],
      };
      for (const key of Object.keys(v))
        if (!fields[String(v.type ?? "message")].includes(key))
          fail(
            `${path}.${key}`,
            "Unsupported input property; history was not modified",
          );
      // phase, signatures, encrypted reasoning, IDs and results remain intact.
      if ((v.type ?? "message") === "message")
        retain(
          v,
          "internal_chat_message_metadata_passthrough",
          `${path}.internal_chat_message_metadata_passthrough`,
        );
    });
    if (body.reasoning != null) {
      if (!object(body.reasoning))
        return fail("$.reasoning", "Expected reasoning configuration");
      for (const key of Object.keys(body.reasoning))
        if (
          ![
            "effort",
            "summary",
            "enabled",
            "max_tokens",
            "mode",
            "context",
          ].includes(key)
        )
          fail(`$.reasoning.${key}`, "Unsupported reasoning field");
      if (
        body.reasoning.effort != null &&
        (typeof body.reasoning.effort !== "string" ||
          !this.model.reasoning_efforts.includes(body.reasoning.effort))
      )
        fail(
          "$.reasoning.effort",
          "Effort is not advertised by the selected model",
        );
    }
    if (
      body.text != null &&
      (!object(body.text) ||
        Object.keys(body.text).some(
          (k) => !["format", "verbosity"].includes(k),
        ))
    )
      fail("$.text", "Unsupported text configuration");
    if (
      body.include != null &&
      (!Array.isArray(body.include) ||
        body.include.some(
          (v) =>
            ![
              "file_search_call.results",
              "message.input_image.image_url",
              "computer_call_output.output.image_url",
              "reasoning.encrypted_content",
              "code_interpreter_call.outputs",
            ].includes(String(v)),
        ))
    )
      fail("$.include", "Unsupported included response property");
    // Require actual upstream support, never ignore tool/sampling parameters.
    body.provider = { require_parameters: true };
    return Buffer.from(JSON.stringify(body));
  }
}
export function openRouterBridge(
  options: Omit<
    Parameters<typeof responsesBridge>[0],
    "label" | "errorPrefix" | "envelope"
  > & { model: ModelCapabilities },
) {
  return responsesBridge({
    ...options,
    endpoint: openRouterEndpoint(options.endpoint),
    label: "OpenRouter",
    errorPrefix: "OPENROUTER",
    envelope: () => new OpenRouterEnvelope(options.model),
  });
}
export const prepareOpenRouterProcess: typeof prepareAxiomProcess = (options) =>
  prepareResponsesProcess(options, {
    id: "synora_openrouter",
    name: "OpenRouter",
    models: openRouterModels,
    validate: validateOpenRouterSelection,
    bridge: openRouterBridge,
  });
