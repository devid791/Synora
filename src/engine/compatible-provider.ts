import { z } from "zod";
import type { prepareAxiomProcess } from "./axiom-process";
import { bearerHeaders } from "./axiom-auth";
import type { ModelCapabilities } from "../shared/contracts";
import {
  compatibleEndpoint,
  compatibleModelOverrideSchema,
  compatibleSettingsSchema,
  type CompatibleModelOverride,
  type CompatibleSettings,
} from "../shared/compatible-provider";
import { ResponsesToolCodec } from "./responses-tool-codec";
import {
  ProviderCompatibilityError,
  prepareResponsesProcess,
  responsesBridge,
} from "./responses-provider";

export {
  compatibleEndpoint,
  compatibleModelOverrideSchema,
  compatibleSettingsSchema,
  type CompatibleModelOverride,
  type CompatibleSettings,
};

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
function fail(path: string, reason: string): never {
  throw new ProviderCompatibilityError(
    "COMPATIBLE_COMPATIBILITY",
    path,
    reason,
  );
}
function fields(value: Json, allowed: string[], path: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail(
        `${path}.${key}`,
        "Unsupported Responses property; original data was not silently discarded",
      );
}
function settingsContract(settings: CompatibleSettings | undefined) {
  if (!settings)
    throw Error(
      "Select the Responses protocol and configure model capabilities for this endpoint; Chat-only endpoints are not supported by this adapter",
    );
  return compatibleSettingsSchema.parse(settings);
}
function authorization(endpoint: string, token?: string) {
  if (token === undefined || token === "") return {};
  if (
    new URL(endpoint).protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)
  )
    throw Error(
      "A bearer credential cannot be sent over remote plaintext HTTP; configure HTTPS or choose anonymous authentication for this private endpoint",
    );
  return bearerHeaders(endpoint, token);
}
async function responseText(response: Response, bound: number) {
  const reader = response.body?.getReader();
  if (!reader) throw Error("Compatible endpoint returned no response body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) > bound)
      throw Error("Compatible response exceeds transport memory bound");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > bound)
        throw Error("Compatible response exceeds transport memory bound");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await reader.cancel();
  }
}
const catalogSchema = z
  .object({
    data: z.array(z.object({ id: z.string().min(1).max(512) }).passthrough()),
  })
  .passthrough();

/** No model-name heuristics. These fields are explicit catalog evidence only;
 * a /models endpoint returning IDs alone needs an operator supplement. The
 * optional capabilities object uses the same camelCase schema as overrides.
 * Unknown catalog metadata is informational, not an executable capability. */
function catalogCapabilities(entry: Json): Json {
  const architecture = object(entry.architecture) ? entry.architecture : {};
  const caps = object(entry.capabilities) ? entry.capabilities : {};
  return Object.fromEntries(
    Object.entries({
      contextWindow: entry.context_window ?? entry.context_length,
      reasoningEfforts: entry.reasoning_efforts,
      defaultReasoningEffort: entry.default_reasoning_effort,
      inputModalities: entry.input_modalities ?? architecture.input_modalities,
      outputModalities:
        entry.output_modalities ?? architecture.output_modalities,
      tools:
        entry.tools ??
        (Array.isArray(entry.supported_parameters)
          ? entry.supported_parameters.includes("tools")
          : undefined),
      supportedParameters: entry.supported_parameters,
      ...Object.fromEntries(
        Object.keys(compatibleModelOverrideSchema.shape)
          .filter((key) => Object.hasOwn(caps, key))
          .map((key) => [key, caps[key]]),
      ),
    }).filter(([, value]) => value !== undefined),
  );
}
function resolveCapabilities(source: Json) {
  const caps: Json = {},
    problems: string[] = [];
  for (const [key, schema] of Object.entries(
    compatibleModelOverrideSchema.shape,
  )) {
    const result = schema.safeParse(source[key]);
    if (result.success) {
      if (result.data !== undefined) caps[key] = result.data;
    } else problems.push(`invalid ${key}`);
  }
  const parsed = caps as CompatibleModelOverride;
  for (const key of [
    "contextWindow",
    "reasoningEfforts",
    "inputModalities",
    "outputModalities",
    "tools",
  ])
    if (caps[key] === undefined && !problems.includes(`invalid ${key}`))
      problems.push(`missing ${key}`);
  if (parsed.tools === false)
    problems.push("tools must support function calling for the Core executor");
  if (parsed.inputModalities && !parsed.inputModalities.includes("text"))
    problems.push("text input is required");
  if (parsed.outputModalities && !parsed.outputModalities.includes("text"))
    problems.push("text output is required");
  if (
    parsed.defaultReasoningEffort != null &&
    !parsed.reasoningEfforts?.includes(parsed.defaultReasoningEffort)
  )
    problems.push("defaultReasoningEffort is not in reasoningEfforts");
  return { caps: parsed, problems };
}

export async function compatibleModels(
  endpoint: string,
  token?: string,
  settings?: CompatibleSettings,
): Promise<ModelCapabilities[]> {
  const configured = settingsContract(settings);
  endpoint = compatibleEndpoint(endpoint);
  const response = await fetch(`${endpoint}/models`, {
    headers: authorization(endpoint, token),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    let message = await responseText(response, 65536);
    if (token)
      for (const secret of new Set([token, token.trim()]))
        if (secret) message = message.split(secret).join("[REDACTED]");
    throw Error(`Compatible model catalog HTTP ${response.status}: ${message}`);
  }
  const catalog = catalogSchema.parse(
    JSON.parse(await responseText(response, 8 * 1024 * 1024)),
  );
  if (
    catalog.has_more === true ||
    (object(catalog.links) && catalog.links.next)
  )
    throw Error(
      "Compatible model catalog is paginated; this adapter requires a complete /models list and will not silently omit models or follow catalog URLs",
    );
  const ids = new Set<string>();
  return catalog.data.map((entry): ModelCapabilities => {
    if (ids.has(entry.id))
      throw Error("Compatible endpoint returned duplicate model identities");
    ids.add(entry.id);
    const overrides = configured.modelOverrides;
    const override =
      overrides && Object.hasOwn(overrides, entry.id)
        ? overrides[entry.id]
        : undefined;
    const { caps, problems } = resolveCapabilities({
      ...catalogCapabilities(entry),
      ...override,
    });
    return {
      id: entry.id,
      context_window: caps.contextWindow ?? null,
      context_window_options: [],
      reasoning_efforts: caps.reasoningEfforts ?? [],
      ...(caps.defaultReasoningEffort != null
        ? { default_reasoning_effort: caps.defaultReasoningEffort }
        : {}),
      ...(problems.length
        ? {
            unavailableReason: `Configure modelOverrides[${JSON.stringify(entry.id)}]: ${problems.join("; ")}. Verify the operator's Responses capability contract; no limits were invented.`,
          }
        : {}),
      providerModel: {
        provider: "compatible",
        aliases: [],
        inputModalities: caps.inputModalities ?? [],
        description: `${entry.id} · /models identity; ${override ? "operator capabilities supplement catalog metadata" : "catalog capability metadata only"}; explicit Responses protocol, not Chat-only compatibility or inference qualification${endpoint.startsWith("http:") ? "; HTTP sends prompts/results in plaintext" : ""}`,
        compatible: caps,
      },
    };
  });
}
export function validateCompatibleSelection(
  models: ModelCapabilities[],
  id: string,
  effort?: string,
) {
  const model = models.find((entry) => entry.id === id);
  if (!model || model.providerModel?.provider !== "compatible")
    throw Error(
      "Selected model is not in this compatible endpoint's /models catalog; manual overrides cannot fabricate catalog identities",
    );
  if (model.unavailableReason) throw Error(model.unavailableReason);
  const { caps, problems } = resolveCapabilities(
    model.providerModel.compatible ?? {},
  );
  if (problems.length)
    throw Error(
      `Compatible model capability contract is incomplete: ${problems.join("; ")}`,
    );
  if (
    caps.contextWindow !== model.context_window ||
    JSON.stringify(caps.reasoningEfforts) !==
      JSON.stringify(model.reasoning_efforts) ||
    JSON.stringify(caps.inputModalities) !==
      JSON.stringify(model.providerModel.inputModalities) ||
    (caps.defaultReasoningEffort ?? undefined) !==
      model.default_reasoning_effort
  )
    throw Error(
      "Compatible model selection differs from its resolved capability contract; reload the catalog",
    );
  if (effort && !model.reasoning_efforts.includes(effort))
    throw Error(
      "Selected effort is not declared by this compatible model; update its capability contract if the operator supports it",
    );
  return model;
}

/** Stateless Responses only. The shared codec owns reversible namespace/custom
 * tools, results, SSE and call IDs; no OpenRouter routing fields, role rewrites,
 * server-side history or hosted OpenAI tools are introduced here. */
export class CompatibleEnvelope {
  readonly tools = new ResponsesToolCodec({
    maxTools: null,
    provider: "Compatible endpoint",
  });
  readonly metadata: { path: string; value: unknown }[] = [];
  private readonly caps: CompatibleModelOverride;
  constructor(private readonly model: ModelCapabilities) {
    validateCompatibleSelection([model], model.id);
    this.caps = model.providerModel!.compatible!;
  }
  private supports(parameter: string, path = `$.${parameter}`) {
    if (!this.caps.supportedParameters?.includes(parameter))
      fail(
        path,
        `Parameter ${parameter} is not declared in this model's supportedParameters; verify endpoint support and supplement its capability contract`,
      );
  }
  private content(value: unknown, path: string, images: boolean) {
    if (typeof value === "string") return;
    if (!Array.isArray(value))
      fail(path, "Expected original text or content parts");
    for (const [i, part] of value.entries()) {
      const p = `${path}[${i}]`;
      if (!object(part)) fail(p, "Expected content part");
      if (part.type === "input_text" || part.type === "output_text") {
        fields(part, ["type", "text", "annotations", "logprobs"], p);
        if (typeof part.text !== "string") fail(`${p}.text`, "Expected text");
      } else if (part.type === "input_image") {
        if (!images || !this.caps.inputModalities?.includes("image"))
          fail(
            p,
            "This model/role does not declare image input; no placeholder substitution",
          );
        fields(part, ["type", "image_url", "detail"], p);
        if (typeof part.image_url !== "string" || !part.image_url)
          fail(
            `${p}.image_url`,
            "Expected an image URL or data URI, not a hosted file reference",
          );
        if (
          part.detail != null &&
          !["auto", "low", "high", "original"].includes(String(part.detail))
        )
          fail(`${p}.detail`, "Unknown image detail");
      } else if (part.type === "refusal") {
        fields(part, ["type", "refusal"], p);
        if (typeof part.refusal !== "string")
          fail(`${p}.refusal`, "Expected refusal text");
      } else
        fail(
          `${p}.type`,
          "Unsupported content; original data was not discarded",
        );
    }
  }
  request(raw: Buffer) {
    let source: unknown;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return fail("$", "Expected valid UTF-8 JSON");
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
        "store",
        "stream",
        "include",
        "prompt_cache_key",
        "text",
        "client_metadata",
        "session_id",
        "max_output_tokens",
        "temperature",
        "top_p",
        "user",
        "metadata",
        "truncation",
        "background",
        "previous_response_id",
      ],
      "$",
    );
    if (source.model !== this.model.id)
      fail("$.model", "Request differs from selected model");
    if (source.stream !== true)
      fail("$.stream", "Core requires streaming Responses");
    if (source.store !== false)
      fail(
        "$.store",
        "Core owns complete history; provider storage must be false",
      );
    if (source.previous_response_id != null)
      fail(
        "$.previous_response_id",
        "Send full Core history, not server-side references",
      );
    if (source.background != null && source.background !== false)
      fail("$.background", "Core requires foreground completion");
    if (source.truncation != null && source.truncation !== "disabled")
      fail("$.truncation", "History must not be silently truncated upstream");
    if (source.instructions != null && typeof source.instructions !== "string")
      fail("$.instructions", "Expected original instructions text");
    if (source.client_metadata != null && !object(source.client_metadata))
      fail("$.client_metadata", "Expected Core metadata object");
    if (source.session_id != null && typeof source.session_id !== "string")
      fail("$.session_id", "Expected Core session identity");
    for (const key of [
      "parallel_tool_calls",
      "prompt_cache_key",
      "max_output_tokens",
      "temperature",
      "top_p",
      "user",
      "metadata",
    ])
      if (source[key] != null) this.supports(key);
    if (
      source.parallel_tool_calls != null &&
      typeof source.parallel_tool_calls !== "boolean"
    )
      fail("$.parallel_tool_calls", "Expected a boolean");
    if (
      source.max_output_tokens != null &&
      (!Number.isSafeInteger(source.max_output_tokens) ||
        Number(source.max_output_tokens) <= 0)
    )
      fail("$.max_output_tokens", "Expected a positive integer");
    if (source.reasoning != null) {
      if (!object(source.reasoning))
        fail("$.reasoning", "Expected reasoning configuration");
      fields(source.reasoning, ["effort", "summary"], "$.reasoning");
      if (
        source.reasoning.effort != null &&
        (typeof source.reasoning.effort !== "string" ||
          !this.model.reasoning_efforts.includes(source.reasoning.effort))
      )
        fail("$.reasoning.effort", "Effort is not declared for this model");
      if (source.reasoning.summary != null) this.supports("reasoning.summary");
    }
    if (source.include != null) {
      if (!Array.isArray(source.include))
        fail("$.include", "Expected included response fields");
      for (const parameter of source.include) {
        if (
          parameter !== "reasoning.encrypted_content" &&
          parameter !== "message.input_image.image_url"
        )
          fail(
            "$.include",
            "Hosted OpenAI tool/include features are not mounted in this executor",
          );
        this.supports(parameter, "$.include");
      }
    }
    if (source.text != null) {
      if (!object(source.text)) fail("$.text", "Expected text configuration");
      fields(source.text, ["format", "verbosity"], "$.text");
      for (const key of Object.keys(source.text)) this.supports(`text.${key}`);
    }
    const body = this.tools.request(source);
    const retain = (value: Json, key: string, path: string) => {
      if (Object.hasOwn(value, key)) {
        this.metadata.push({ path: `${path}.${key}`, value: value[key] });
        delete value[key];
      }
    };
    retain(body, "client_metadata", "$");
    retain(body, "session_id", "$");
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
        if (
          !["system", "developer", "user", "assistant"].includes(
            String(item.role),
          )
        )
          fail(`${p}.role`, "Unknown role");
        this.content(item.content, `${p}.content`, item.role === "user");
        retain(item, "internal_chat_message_metadata_passthrough", p);
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
        const seen = isCall ? calls : results;
        if (
          typeof item.call_id !== "string" ||
          !item.call_id ||
          seen.has(item.call_id)
        )
          fail(`${p}.call_id`, "Missing or duplicate original call identity");
        if (!isCall && !calls.has(item.call_id))
          fail(`${p}.call_id`, "Tool result must follow its original call");
        seen.add(item.call_id);
        if (isCall) {
          if (typeof item.arguments !== "string")
            fail(`${p}.arguments`, "Expected original argument string");
          try {
            JSON.parse(item.arguments);
          } catch {
            fail(`${p}.arguments`, "Malformed original JSON arguments");
          }
        } else this.content(item.output, `${p}.output`, true);
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
            "format",
            "signature",
          ],
          p,
        );
        // Original plain/opaque reasoning and signatures are never rewritten.
        if (item.encrypted_content != null)
          this.supports(
            "reasoning.encrypted_content",
            `${p}.encrypted_content`,
          );
      } else
        fail(
          `${p}.type`,
          "Unsupported history type or hosted item; no silent removal",
        );
    }
    if (
      calls.size !== results.size ||
      [...calls].some((id) => !results.has(id))
    )
      fail(
        "$.input",
        "Every original tool call must have exactly one matching result",
      );
    return Buffer.from(JSON.stringify(body));
  }
}

export function compatibleBridge(
  options: Omit<
    Parameters<typeof responsesBridge>[0],
    "label" | "errorPrefix" | "envelope" | "native" | "allowAnonymous" | "token"
  > & { token?: string; model: ModelCapabilities },
) {
  const endpoint = compatibleEndpoint(options.endpoint);
  const headers = authorization(endpoint, options.token);
  validateCompatibleSelection([options.model], options.model.id);
  return responsesBridge({
    endpoint,
    // Use the normalized credential for the shared transport's redaction set,
    // too; padded caller input must not leave the actual wire token unredacted.
    token: headers.Authorization?.slice("Bearer ".length) ?? "",
    allowAnonymous: true,
    deadlineMs: options.deadlineMs,
    onRequest: options.onRequest,
    label: "Compatible endpoint",
    errorPrefix: "COMPATIBLE",
    envelope: () => new CompatibleEnvelope(options.model),
  });
}
export function prepareCompatibleProcess(
  options: Parameters<typeof prepareAxiomProcess>[0],
  settings: CompatibleSettings,
): ReturnType<typeof prepareAxiomProcess> {
  const configured = settingsContract(settings);
  return prepareResponsesProcess(options, {
    id: "synora_compatible",
    name: "Compatible endpoint (Responses)",
    allowAnonymous: true,
    models: (endpoint, token) => compatibleModels(endpoint, token, configured),
    validate: validateCompatibleSelection,
    bridge: compatibleBridge,
  });
}
