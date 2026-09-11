import { ResponsesToolCodec } from "./responses-tool-codec";
import { ProviderCompatibilityError } from "./responses-provider";
import { AnthropicHistory } from "./anthropic-history";
import type { ModelCapabilities } from "../shared/contracts";
export type NativeObject = Record<string, any>;
export const isObject = (v: unknown): v is NativeObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function anthropicFail(path: string, reason: string): never {
  throw new ProviderCompatibilityError("ANTHROPIC_COMPATIBILITY", path, reason);
}
export function fields(v: NativeObject, names: string[], path: string) {
  for (const k of Object.keys(v))
    if (!names.includes(k))
      anthropicFail(
        `${path}.${k}`,
        "No verified native Messages mapping for this property",
      );
}
export function nativeThinking(v: unknown): NativeObject {
  if (!isObject(v))
    return anthropicFail(
      "$.reasoning",
      "Expected original native thinking block",
    );
  if (v.type === "thinking") {
    fields(v, ["type", "thinking", "signature"], "$.reasoning");
    if (
      typeof v.thinking !== "string" ||
      typeof v.signature !== "string" ||
      !v.signature
    )
      anthropicFail("$.reasoning", "Thinking requires its original signature");
  } else if (v.type === "redacted_thinking") {
    fields(v, ["type", "data"], "$.reasoning");
    if (typeof v.data !== "string" || !v.data)
      anthropicFail("$.reasoning.data", "Missing redacted thinking data");
  } else
    anthropicFail("$.reasoning.type", "Not an original native thinking block");
  return v;
}
export class AnthropicEnvelope {
  readonly tools = new ResponsesToolCodec();
  readonly metadata: { path: string; value: unknown }[] = [];
  constructor(
    readonly model: ModelCapabilities,
    readonly history: AnthropicHistory,
  ) {}
  request(raw: Buffer) {
    let source;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return anthropicFail("$", "Expected valid UTF-8 JSON");
    }
    if (!isObject(source))
      return anthropicFail("$", "Expected a Core Responses object");
    fields(
      source,
      [
        "model",
        "instructions",
        "input",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "reasoning",
        "store",
        "stream",
        "include",
        "prompt_cache_key",
        "client_metadata",
        "max_output_tokens",
        "temperature",
        "top_p",
        "text",
        "metadata",
        "session_id",
        "previous_response_id",
        "background",
        "truncation",
      ],
      "$",
    );
    if (source.model !== this.model.id)
      anthropicFail(
        "$.model",
        "Model identity differs from the selected catalog entry",
      );
    if (source.stream !== true || source.store !== false)
      anthropicFail(
        "$",
        "Core must own streaming and complete stateless history",
      );
    if (
      source.previous_response_id != null ||
      source.background === true ||
      (source.truncation != null && source.truncation !== "disabled")
    )
      anthropicFail(
        "$",
        "Provider-owned history, background execution or silent truncation is not supported",
      );
    if (
      source.include != null &&
      (!Array.isArray(source.include) ||
        source.include.some(
          (x: unknown) => x !== "reasoning.encrypted_content",
        ))
    )
      anthropicFail(
        "$.include",
        "This native mapping supports retained reasoning only",
      );
    const core = this.tools.request(source),
      system: NativeObject[] = [],
      messages: NativeObject[] = [];
    const keep = (path: string, value: unknown) => {
      if (value !== undefined)
        this.metadata.push({ path, value: structuredClone(value) });
    };
    for (const k of [
      "client_metadata",
      "prompt_cache_key",
      "metadata",
      "session_id",
    ])
      keep(`$.${k}`, core[k]);
    const text = (value: unknown, path: string) => {
      if (typeof value !== "string")
        return anthropicFail(path, "Expected text");
      return { type: "text", text: value };
    };
    const content = (value: unknown, path: string): NativeObject[] => {
      if (typeof value === "string") return [text(value, path)];
      if (!Array.isArray(value))
        return anthropicFail(path, "Expected content array");
      return value.map((v, i) => {
        const p = `${path}[${i}]`;
        if (!isObject(v)) return anthropicFail(p, "Expected content block");
        if (v.type === "input_text" || v.type === "output_text") {
          fields(v, ["type", "text", "annotations", "logprobs"], p);
          if (v.annotations?.length || v.logprobs?.length)
            anthropicFail(
              p,
              "Provider-specific annotations cannot be silently removed",
            );
          return text(v.text, `${p}.text`);
        }
        if (v.type === "input_image") {
          fields(v, ["type", "image_url", "detail"], p);
          if (!this.model.providerModel?.inputModalities.includes("image"))
            anthropicFail(p, "Selected model does not support images");
          if (v.detail != null && v.detail !== "auto")
            anthropicFail(
              `${p}.detail`,
              "Native Messages has no equivalent image-detail override",
            );
          if (typeof v.image_url !== "string")
            anthropicFail(p, "Expected image URL or data URI");
          const data =
            /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              v.image_url,
            );
          if (data)
            return {
              type: "image",
              source: { type: "base64", media_type: data[1], data: data[2] },
            };
          let url;
          try {
            url = new URL(v.image_url);
          } catch {
            return anthropicFail(p, "Invalid image URL");
          }
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.hash
          )
            anthropicFail(
              p,
              "External images require a credential-free HTTPS URL",
            );
          return { type: "image", source: { type: "url", url: v.image_url } };
        }
        return anthropicFail(
          `${p}.type`,
          "Unsupported content block; original content was not removed",
        );
      });
    };
    const append = (role: "user" | "assistant", blocks: NativeObject[]) => {
      if (messages.at(-1)?.role === role)
        messages.at(-1)!.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    if (core.instructions != null)
      system.push(text(core.instructions, "$.instructions"));
    if (!Array.isArray(core.input))
      return anthropicFail("$.input", "Expected complete Core history");
    core.input.forEach((v: unknown, i: number) => {
      const p = `$.input[${i}]`;
      if (!isObject(v)) return anthropicFail(p, "Expected an input item");
      keep(p, v); // IDs/phase/metadata retain original Core meaning; native API lacks these fields.
      if ((v.type ?? "message") === "message") {
        fields(
          v,
          [
            "type",
            "id",
            "role",
            "content",
            "phase",
            "status",
            "internal_chat_message_metadata_passthrough",
          ],
          p,
        );
        const blocks = content(v.content, `${p}.content`);
        if (v.role === "system" || v.role === "developer") {
          if (messages.length)
            anthropicFail(
              `${p}.role`,
              "Mid-history privileged instructions need a qualified native ordering contract",
            );
          if (blocks.some((b) => b.type !== "text"))
            anthropicFail(p, "System instructions must be text");
          system.push(...blocks);
        } else if (v.role === "user" || v.role === "assistant")
          append(v.role, blocks);
        else anthropicFail(`${p}.role`, "Unsupported conversation role");
      } else if (v.type === "function_call") {
        fields(v, ["type", "id", "call_id", "name", "arguments", "status"], p);
        let args;
        try {
          args = JSON.parse(v.arguments);
        } catch {
          return anthropicFail(
            `${p}.arguments`,
            "Tool arguments must be valid JSON",
          );
        }
        if (
          !isObject(args) ||
          typeof v.call_id !== "string" ||
          !/^[\w-]+$/.test(v.call_id)
        )
          anthropicFail(
            p,
            "Invalid native tool arguments or original call identity",
          );
        append("assistant", [
          { type: "tool_use", id: v.call_id, name: v.name, input: args },
        ]);
      } else if (v.type === "function_call_output") {
        fields(v, ["type", "id", "call_id", "output", "status"], p);
        if (typeof v.call_id !== "string" || !/^[\w-]+$/.test(v.call_id))
          anthropicFail(
            `${p}.call_id`,
            "Invalid original tool result identity",
          );
        append("user", [
          {
            type: "tool_result",
            tool_use_id: v.call_id,
            content: content(v.output, `${p}.output`),
          },
        ]);
      } else if (v.type === "reasoning") {
        fields(
          v,
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
        let block;
        try {
          block = nativeThinking(this.history.restore(v.encrypted_content));
        } catch {
          return anthropicFail(
            `${p}.encrypted_content`,
            "Cannot restore exact native thinking for this provider/model",
          );
        }
        append("assistant", [block]);
      } else
        anthropicFail(`${p}.type`, "No native mapping for this history item");
    });
    const native = this.model.providerModel?.anthropic;
    if (!native?.maxOutput)
      anthropicFail("$.model", "Missing authoritative output limit");
    const max = core.max_output_tokens ?? native.maxOutput;
    if (
      typeof max !== "number" ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > native.maxOutput
    )
      anthropicFail(
        "$.max_output_tokens",
        "Output limit is outside model capabilities",
      );
    const body: NativeObject = {
      model: core.model,
      stream: true,
      max_tokens: max,
      messages,
      ...(system.length ? { system } : {}),
    };
    if (core.reasoning != null) {
      if (!isObject(core.reasoning))
        anthropicFail("$.reasoning", "Expected reasoning configuration");
      fields(core.reasoning, ["effort"], "$.reasoning");
      if (core.reasoning.effort != null) {
        if (!this.model.reasoning_efforts.includes(core.reasoning.effort))
          anthropicFail(
            "$.reasoning.effort",
            "Effort is not advertised by this model",
          );
        body.output_config = { effort: core.reasoning.effort };
      }
    }
    if (native.adaptiveThinking) body.thinking = { type: "adaptive" };
    if (core.text != null) {
      if (!isObject(core.text))
        anthropicFail("$.text", "Expected output configuration");
      fields(core.text, ["format"], "$.text");
      if (core.text.format?.type === "json_schema") {
        if (!native.structuredOutputs)
          anthropicFail(
            "$.text.format",
            "Model does not advertise structured outputs",
          );
        fields(
          core.text.format,
          ["type", "name", "schema", "strict", "description"],
          "$.text.format",
        );
        body.output_config = {
          ...body.output_config,
          format: { type: "json_schema", schema: core.text.format.schema },
        };
        keep("$.text.format", core.text.format);
      } else if (core.text.format?.type !== "text")
        anthropicFail("$.text.format", "Unsupported output format");
    }
    for (const k of ["temperature", "top_p"])
      if (core[k] != null) {
        if (body.thinking)
          anthropicFail(
            `$.${k}`,
            "Adaptive thinking cannot preserve this sampling override",
          );
        body[k] = core[k];
      }
    body.tools = (core.tools as NativeObject[]).map((t, i) => {
      fields(
        t,
        ["type", "name", "description", "parameters", "strict"],
        `$.tools[${i}]`,
      );
      if (t.type !== "function")
        anthropicFail(`$.tools[${i}]`, "Expected reversible function encoding");
      if (t.strict === true && !native.structuredOutputs)
        anthropicFail(
          `$.tools[${i}].strict`,
          "Model cannot satisfy this strict tool contract",
        );
      return {
        name: t.name,
        input_schema: t.parameters,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      };
    });
    const choice = core.tool_choice ?? "auto";
    if (
      typeof choice === "string" &&
      ["auto", "none", "required"].includes(choice)
    )
      body.tool_choice = { type: choice === "required" ? "any" : choice };
    else if (isObject(choice) && choice.type === "function") {
      fields(choice, ["type", "name"], "$.tool_choice");
      body.tool_choice = { type: "tool", name: choice.name };
    } else anthropicFail("$.tool_choice", "Unsupported native tool choice");
    if (body.thinking && ["any", "tool"].includes(body.tool_choice.type))
      anthropicFail(
        "$.tool_choice",
        "Forced tool choice is incompatible with native thinking",
      );
    if (core.parallel_tool_calls != null) {
      if (typeof core.parallel_tool_calls !== "boolean")
        anthropicFail("$.parallel_tool_calls", "Expected boolean");
      if (body.tool_choice.type !== "none")
        body.tool_choice.disable_parallel_tool_use = !core.parallel_tool_calls;
    }
    if (!body.tools.length) {
      delete body.tools;
      if (choice === "auto" || choice === "none") delete body.tool_choice;
    }
    return Buffer.from(JSON.stringify(body));
  }
}
