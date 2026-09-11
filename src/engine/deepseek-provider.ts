import { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { prepareAxiomProcess } from "./axiom-process";
import type { ModelCapabilities } from "../shared/contracts";
import { bearerHeaders } from "./axiom-auth";
import { ResponsesToolCodec } from "./responses-tool-codec";
import {
  ProviderCompatibilityError,
  prepareResponsesProcess,
  responsesBridge,
} from "./responses-provider";

type Json = Record<string, any>;
const object = (v: unknown): v is Json =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fail(path: string, reason: string): never {
  throw new ProviderCompatibilityError("DEEPSEEK_COMPATIBILITY", path, reason);
}
function fields(v: Json, allowed: string[], path: string) {
  for (const key of Object.keys(v))
    if (!allowed.includes(key))
      fail(
        `${path}.${key}`,
        "No verified DeepSeek mapping; original data was not silently discarded",
      );
}
export function deepSeekEndpoint(value: string) {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !["", "/v1"].includes(u.pathname.replace(/\/$/, "")) ||
    !(
      (u.protocol === "https:" &&
        u.hostname === "api.deepseek.com" &&
        !u.port) ||
      (u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
    )
  )
    throw Error(
      "DeepSeek requires its official HTTPS endpoint (HTTP loopback is reserved for local qualification)",
    );
  return u.href.replace(/\/$/, "");
}
// Official /models reports identities only. This dated contract augments ONLY
// returned identities; unknown future models remain visible, never guessed.
// The docs express limits as 1M / 384K. Decimal client budgets are conservative,
// not a claim of an exact token boundary or public inference qualification.
const known = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
]);
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export async function deepSeekModels(
  endpoint: string,
  token?: string,
): Promise<ModelCapabilities[]> {
  endpoint = deepSeekEndpoint(endpoint);
  if (!token) throw Error("Save a DeepSeek API key first");
  const response = await fetch(`${endpoint}/models`, {
    headers: bearerHeaders(endpoint, token),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`DeepSeek model catalog returned HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("DeepSeek returned no model catalog");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024)
        throw Error("Model catalog exceeds transport memory bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const catalog = z
    .object({
      object: z.literal("list"),
      data: z.array(
        z.object({
          id: z.string().min(1).max(512),
          object: z.literal("model"),
          owned_by: z.string(),
        }),
      ),
    })
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    );
  const ids = new Set<string>();
  return catalog.data.map((m) => {
    if (ids.has(m.id))
      throw Error("DeepSeek returned duplicate model identities");
    ids.add(m.id);
    const supported = known.has(m.id);
    return {
      id: m.id,
      context_window: supported ? 1000000 : null,
      context_window_options: [],
      reasoning_efforts: supported ? [...efforts] : [],
      ...(supported
        ? { default_reasoning_effort: "high" }
        : {
            unavailableReason:
              "DeepSeek returned this model, but its capability contract is not yet qualified",
          }),
      providerModel: {
        provider: "deepseek" as const,
        aliases: [],
        inputModalities:
          m.id === "deepseek-v4-flash-vision-exp"
            ? ["text", "image"]
            : ["text"],
        description: `${m.id} · authenticated DeepSeek identity; 2026-09-09 official Responses contract, conservative 1,000,000-token client budget; not an inference benchmark`,
      },
    };
  });
}
export function validateDeepSeekSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const model = models.find((m) => m.id === id);
  if (!model)
    throw Error("Selected model is not in this DeepSeek account catalog");
  if (model.unavailableReason) throw Error(model.unavailableReason);
  if (effort && !model.reasoning_efforts.includes(effort))
    throw Error("Selected effort is not supported by this DeepSeek model");
  return model;
}

/** DeepSeek has native Responses; preserve plain reasoning, without converting
 * to Chat Completions or losing it across Core's history/cold restart. */
export class DeepSeekCodec extends ResponsesToolCodec {
  readonly validators = new Map<string, ValidateFunction>();
  private argumentsByItem = new Map<string, string>();
  override event(source: Json): Json | null {
    if (
      source.type === "response.output_item.added" &&
      source.item?.type === "function_call"
    )
      this.argumentsByItem.set(source.item.id, source.item.arguments);
    if (source.type === "response.function_call_arguments.delta") {
      const prior = this.argumentsByItem.get(source.item_id);
      if (prior === undefined || typeof source.delta !== "string")
        fail("$.delta", "Unannounced argument delta");
      if (prior.length + source.delta.length > 4 * 1024 * 1024)
        fail("$.delta", "Tool arguments exceed transport memory bound");
      this.argumentsByItem.set(source.item_id, prior + source.delta);
    }
    const checkArguments = (id: string, args: unknown) => {
      const prior = this.argumentsByItem.get(id);
      if (prior === undefined || typeof args !== "string" || prior !== args)
        fail(
          "$.arguments",
          "Final arguments differ from announced streamed arguments",
        );
    };
    if (source.type === "response.function_call_arguments.done")
      checkArguments(source.item_id, source.arguments);
    const normalize = (item: Json, path: string) => {
      if (item.type === "reasoning") {
        if (item.encrypted_content)
          fail(
            path,
            "Unexpected opaque DeepSeek reasoning; no fabricated decryption",
          );
        if (item.summary?.length)
          fail(path, "Unexpected provider reasoning summary");
        // Core requires summary even though DeepSeek supplies full reasoning_text.
        return { ...item, summary: [], encrypted_content: null };
      }
      if (item.type === "function_call") {
        checkArguments(item.id, item.arguments);
        const validator = this.validators.get(item.name);
        if (!validator)
          return fail(
            `${path}.name`,
            "Tool is not in this request's mounted catalog",
          );
        let args;
        try {
          args = JSON.parse(item.arguments);
        } catch {
          return fail(`${path}.arguments`, "Malformed tool arguments");
        }
        if (!validator(args))
          fail(
            `${path}.arguments`,
            `Arguments violate original tool schema: ${JSON.stringify(validator.errors)}`,
          );
      }
      return item;
    };
    const event = structuredClone(source);
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "reasoning"
    )
      event.item = normalize(event.item, "$.item");
    if (event.type === "response.output_item.done" && object(event.item))
      event.item = normalize(event.item, "$.item");
    if (
      event.type === "response.completed" &&
      Array.isArray(event.response?.output)
    )
      event.response.output = event.response.output.map(
        (item: Json, i: number) => normalize(item, `$.response.output[${i}]`),
      );
    return super.event(event);
  }
}
export class DeepSeekEnvelope {
  readonly tools = new DeepSeekCodec({ maxTools: null, provider: "DeepSeek" });
  readonly metadata: { path: string; value: unknown }[] = [];
  constructor(private model: ModelCapabilities) {}
  request(raw: Buffer) {
    let source: Json;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return fail("$", "Expected UTF-8 JSON");
    }
    if (!object(source)) fail("$", "Expected a complete Responses request");
    fields(
      source,
      [
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "stream",
        "store",
        "include",
        "prompt_cache_key",
        "client_metadata",
        "metadata",
        "session_id",
        "max_output_tokens",
        "temperature",
        "top_p",
        "text",
        "user",
        "top_logprobs",
        "previous_response_id",
        "background",
        "truncation",
      ],
      "$",
    );
    if (source.model !== this.model.id)
      fail("$.model", "Request differs from selected model");
    if (source.stream !== true)
      fail("$.stream", "Original Core requires streaming Responses");
    if (source.store !== false)
      fail("$.store", "DeepSeek is stateless; Core owns complete history");
    if (source.previous_response_id != null)
      fail(
        "$.previous_response_id",
        "Send full history, not server-side references",
      );
    if (source.background != null && source.background !== false)
      fail("$.background", "Foreground completion is required");
    if (source.truncation != null && source.truncation !== "disabled")
      fail("$.truncation", "History cannot be silently truncated");
    if (
      source.parallel_tool_calls != null &&
      source.parallel_tool_calls !== true
    )
      fail(
        "$.parallel_tool_calls",
        "DeepSeek always enables parallel tools; disabling them has no native equivalent",
      );
    const body = this.tools.request(source) as Json;
    const retain = (v: Json, key: string, path: string) => {
      if (Object.hasOwn(v, key)) {
        this.metadata.push({ path: `${path}.${key}`, value: v[key] });
        delete v[key];
      }
    };
    for (const key of [
      "client_metadata",
      "metadata",
      "session_id",
      "prompt_cache_key",
      "store",
      "previous_response_id",
      "background",
      "truncation",
      "parallel_tool_calls",
    ])
      retain(body, key, "$");
    if (
      body.include != null &&
      (!Array.isArray(body.include) ||
        body.include.some((v: unknown) => v !== "reasoning.encrypted_content"))
    )
      fail("$.include", "Unsupported included field");
    // Native reasoning arrives in content and Core serializes reasoning_text.
    // No encrypted history is promised or lost by omitting this OpenAI request.
    retain(body, "include", "$");
    if (body.instructions != null && typeof body.instructions !== "string")
      fail("$.instructions", "Expected system instructions text");
    const checkContent = (content: unknown, path: string, images: boolean) => {
      if (typeof content === "string") return;
      if (!Array.isArray(content))
        return fail(path, "Expected text or content parts");
      for (const [i, part] of content.entries()) {
        const p = `${path}[${i}]`;
        if (!object(part)) fail(p, "Expected content part");
        if (["input_text", "output_text"].includes(part.type)) {
          fields(part, ["type", "text", "annotations", "logprobs"], p);
          if (typeof part.text !== "string") fail(`${p}.text`, "Expected text");
          if (part.annotations?.length || part.logprobs?.length)
            fail(p, "Annotated history requires an explicit mapping");
        } else if (part.type === "input_image") {
          if (
            !images ||
            !this.model.providerModel?.inputModalities.includes("image")
          )
            fail(
              p,
              "This model/role does not support images; refusing placeholder substitution",
            );
          fields(part, ["type", "image_url", "file_id", "detail"], p);
          if (
            (typeof part.image_url === "string") ===
            (typeof part.file_id === "string")
          )
            fail(p, "Exactly one image URL or uploaded file ID is required");
          if (
            part.detail != null &&
            !["auto", "low", "high", "original"].includes(part.detail)
          )
            fail(`${p}.detail`, "Unsupported image detail");
        } else
          fail(`${p}.type`, "Unsupported content; no placeholder or omission");
      }
    };
    if (!Array.isArray(body.input))
      fail("$.input", "Expected full Core history");
    const calls = new Set<string>(),
      results = new Set<string>();
    for (const [i, item] of body.input.entries()) {
      const p = `$.input[${i}]`;
      if (!object(item)) fail(p, "Expected history item");
      if ((item.type ?? "message") === "message") {
        fields(
          item,
          [
            "type",
            "id",
            "role",
            "content",
            "status",
            "phase",
            "internal_chat_message_metadata_passthrough",
          ],
          p,
        );
        if (!["user", "assistant", "system", "developer"].includes(item.role))
          fail(`${p}.role`, "Unknown role");
        // Unlike OpenAI, DeepSeek treats developer as user. Carry Core's host
        // instructions as system messages in their original order instead.
        if (item.role === "developer") {
          this.metadata.push({ path: `${p}.role`, value: item.role });
          item.role = "system";
        }
        checkContent(item.content, `${p}.content`, item.role === "user");
        retain(item, "internal_chat_message_metadata_passthrough", p);
        retain(item, "phase", p);
      } else if (item.type === "reasoning") {
        fields(
          item,
          [
            "type",
            "id",
            "summary",
            "content",
            "encrypted_content",
            "status",
            "internal_chat_message_metadata_passthrough",
          ],
          p,
        );
        if (item.encrypted_content || item.summary?.length)
          fail(
            p,
            "Only original plain DeepSeek reasoning can be replayed; opaque foreign history is not discarded",
          );
        if (
          !Array.isArray(item.content) ||
          item.content.some(
            (c: unknown) =>
              !object(c) ||
              c.type !== "reasoning_text" ||
              typeof c.text !== "string",
          )
        )
          fail(`${p}.content`, "Expected original reasoning_text parts");
        for (const key of [
          "summary",
          "encrypted_content",
          "internal_chat_message_metadata_passthrough",
        ])
          retain(item, key, p);
      } else if (
        item.type === "function_call" ||
        item.type === "function_call_output"
      ) {
        const isCall = item.type === "function_call";
        fields(
          item,
          isCall
            ? ["type", "id", "call_id", "name", "arguments", "status"]
            : ["type", "id", "call_id", "output", "status"],
          p,
        );
        const set = isCall ? calls : results;
        if (
          typeof item.call_id !== "string" ||
          !item.call_id ||
          set.has(item.call_id)
        )
          fail(`${p}.call_id`, "Missing or duplicate original call identity");
        set.add(item.call_id);
        if (isCall) {
          if (typeof item.arguments !== "string")
            fail(`${p}.arguments`, "Expected original JSON arguments string");
          try {
            JSON.parse(item.arguments);
          } catch {
            fail(`${p}.arguments`, "Malformed JSON arguments");
          }
        } else checkContent(item.output, `${p}.output`, true);
      } else fail(`${p}.type`, "Unsupported history type; no silent removal");
    }
    if (
      calls.size !== results.size ||
      [...calls].some((id) => !results.has(id))
    )
      fail(
        "$.input",
        "Every original call must have exactly one matching result",
      );
    if (body.reasoning != null) {
      if (!object(body.reasoning))
        fail("$.reasoning", "Expected reasoning configuration");
      fields(body.reasoning, ["effort", "summary"], "$.reasoning");
      if (
        body.reasoning.effort != null &&
        !this.model.reasoning_efforts.includes(body.reasoning.effort)
      )
        fail("$.reasoning.effort", "Effort not supported by selected model");
      if (body.reasoning.summary != null && body.reasoning.summary !== "none")
        fail(
          "$.reasoning.summary",
          "DeepSeek does not generate reasoning summaries",
        );
      retain(body.reasoning, "summary", "$.reasoning");
    }
    if (
      body.reasoning?.effort !== "none" &&
      (body.temperature != null || body.top_p != null)
    )
      fail(
        "$.reasoning",
        "Sampling overrides have no effect in DeepSeek thinking mode",
      );
    if (
      body.max_output_tokens != null &&
      (!Number.isSafeInteger(body.max_output_tokens) ||
        body.max_output_tokens < 1 ||
        body.max_output_tokens > 384000)
    )
      fail(
        "$.max_output_tokens",
        "Outside the documented conservative 384K output budget",
      );
    if (body.text != null) {
      if (!object(body.text)) fail("$.text", "Expected text configuration");
      fields(body.text, ["format", "verbosity"], "$.text");
      if (body.text.verbosity != null)
        fail("$.text.verbosity", "DeepSeek does not implement verbosity");
    }
    const ajv = new Ajv({
      strict: true,
      allErrors: true,
      allowUnionTypes: true,
    });
    addFormats(ajv);
    for (const [i, tool] of body.tools.entries()) {
      // Preserve the original JSON schema. Verify the actual returned arguments
      // locally; DeepSeek Responses does not document strict constrained decode.
      try {
        this.tools.validators.set(tool.name, ajv.compile(tool.parameters));
      } catch (e) {
        fail(
          `$.tools[${i}].parameters`,
          `Invalid original schema: ${String(e)}`,
        );
      }
      retain(tool, "strict", `$.tools[${i}]`);
    }
    return Buffer.from(JSON.stringify(body));
  }
}
export function deepSeekBridge(
  options: Omit<
    Parameters<typeof responsesBridge>[0],
    "label" | "errorPrefix" | "envelope"
  > & { model: ModelCapabilities },
) {
  return responsesBridge({
    ...options,
    endpoint: deepSeekEndpoint(options.endpoint),
    label: "DeepSeek",
    errorPrefix: "DEEPSEEK",
    envelope: () => new DeepSeekEnvelope(options.model),
  });
}
export const prepareDeepSeekProcess: typeof prepareAxiomProcess = (options) =>
  prepareResponsesProcess(options, {
    id: "synora_deepseek",
    name: "DeepSeek",
    models: deepSeekModels,
    validate: validateDeepSeekSelection,
    bridge: deepSeekBridge,
  });
