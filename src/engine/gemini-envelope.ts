import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { isDeepStrictEqual } from "node:util";
import { ResponsesToolCodec } from "./responses-tool-codec";
import { ProviderCompatibilityError } from "./responses-provider";
import { NativeHistory } from "./native-history";
import type { ModelCapabilities } from "../shared/contracts";
export type GObject = Record<string, any>;
export const gObject = (v: unknown): v is GObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function gFail(path: string, reason: string): never {
  throw new ProviderCompatibilityError("GEMINI_COMPATIBILITY", path, reason);
}
export function gFields(v: GObject, names: string[], path: string) {
  for (const key of Object.keys(v))
    if (!names.includes(key))
      gFail(
        `${path}.${key}`,
        "No qualified Gemini mapping; original data was not discarded",
      );
}
export function projection(item: GObject): GObject {
  if (item.type === "function_call") {
    let args;
    try {
      args = JSON.parse(item.arguments);
    } catch {
      return gFail("$.input.arguments", "Invalid original tool JSON");
    }
    return {
      type: "function_call",
      call_id: item.call_id,
      name: item.name,
      arguments: args,
    };
  }
  if ((item.type ?? "message") === "message" && item.role === "assistant") {
    const content =
      typeof item.content === "string"
        ? [{ type: "output_text", text: item.content }]
        : item.content;
    if (
      !Array.isArray(content) ||
      content.some(
        (x) =>
          !gObject(x) ||
          !["output_text", "input_text"].includes(x.type) ||
          typeof x.text !== "string" ||
          x.annotations?.length ||
          x.logprobs?.length,
      )
    )
      gFail("$.input.content", "History mirror is not original assistant text");
    return {
      type: "message",
      role: "assistant",
      text: content.map((x) => x.text).join(""),
    };
  }
  return gFail("$.input", "Unexpected item in native history mirror");
}
export class GeminiEnvelope {
  readonly tools = new ResponsesToolCodec({
    maxTools: null,
    provider: "Gemini",
  });
  readonly metadata: { path: string; value: unknown }[] = [];
  readonly validators = new Map<string, ValidateFunction>();
  outputValidator?: ValidateFunction;
  parallel = true;
  private ajv = new Ajv({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  constructor(
    readonly model: ModelCapabilities,
    readonly history: NativeHistory,
  ) {
    addFormats(this.ajv);
  }
  validateCall(name: unknown, args: unknown) {
    if (typeof name !== "string" || !this.validators.has(name))
      gFail(
        "$.functionCall.name",
        "Tool is not in this request's mounted catalog",
      );
    const validate = this.validators.get(name)!;
    if (!validate(args))
      gFail(
        "$.functionCall.args",
        `Arguments violate the original schema: ${this.ajv.errorsText(validate.errors)}`,
      );
  }
  request(raw: Buffer) {
    let source;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return gFail("$", "Expected UTF-8 JSON");
    }
    if (!gObject(source))
      gFail("$", "Expected complete Core Responses request");
    gFields(
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
      gFail("$.model", "Request differs from selected model identity");
    if (
      source.stream !== true ||
      source.store !== false ||
      source.previous_response_id != null ||
      source.background === true ||
      (source.truncation != null && source.truncation !== "disabled")
    )
      gFail("$", "Core must own streaming and complete stateless history");
    if (
      source.include != null &&
      (!Array.isArray(source.include) ||
        source.include.some(
          (x: unknown) => x !== "reasoning.encrypted_content",
        ))
    )
      gFail("$.include", "Only retained native reasoning is supported");
    const core = this.tools.request(source) as GObject;
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
    const contents: GObject[] = [],
      system: GObject[] = [],
      calls = new Map<string, GObject>();
    const text = (v: unknown, path: string) => {
      if (typeof v !== "string") return gFail(path, "Expected text");
      return { text: v };
    };
    const parts = (v: unknown, path: string): GObject[] => {
      if (typeof v === "string") return [text(v, path)];
      if (!Array.isArray(v)) return gFail(path, "Expected content array");
      return v.map((x, i) => {
        const p = `${path}[${i}]`;
        if (!gObject(x)) return gFail(p, "Expected content part");
        if (["input_text", "output_text"].includes(x.type)) {
          gFields(x, ["type", "text", "annotations", "logprobs"], p);
          if (x.annotations?.length || x.logprobs?.length)
            gFail(p, "Annotations require a native mapping");
          return text(x.text, `${p}.text`);
        }
        if (x.type === "input_image") {
          gFields(x, ["type", "image_url", "detail"], p);
          if (x.detail != null && x.detail !== "auto")
            gFail(
              `${p}.detail`,
              "No qualified equivalent for this image detail override",
            );
          const match =
            typeof x.image_url === "string" &&
            /^data:(image\/(?:png|jpeg|webp|heic|heif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              x.image_url,
            );
          if (!match)
            return gFail(
              p,
              "Inline native image required; no unqualified host-side URL fetch",
            );
          return { inlineData: { mimeType: match[1], data: match[2] } };
        }
        return gFail(`${p}.type`, "Unsupported Gemini content type");
      });
    };
    const append = (role: "user" | "model", p: GObject[]) => {
      if (contents.at(-1)?.role === role) contents.at(-1)!.parts.push(...p);
      else contents.push({ role, parts: p });
    };
    if (core.instructions != null)
      system.push(text(core.instructions, "$.instructions"));
    if (!Array.isArray(core.input))
      gFail("$.input", "Expected complete Core history");
    let mirrors: GObject[] = [];
    core.input.forEach((v: unknown, i: number) => {
      const p = `$.input[${i}]`;
      if (!gObject(v)) gFail(p, "Expected original history item");
      keep(p, v);
      if (mirrors.length) {
        if (!isDeepStrictEqual(projection(v), mirrors.shift()))
          gFail(p, "Core history differs from authenticated native response");
        return;
      }
      if (v.type === "reasoning") {
        gFields(
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
        let saved: any;
        try {
          saved = this.history.restore(v.encrypted_content);
        } catch {
          return gFail(
            `${p}.encrypted_content`,
            "Cannot authenticate original Gemini history for this model/endpoint",
          );
        }
        if (
          !gObject(saved) ||
          saved.version !== 1 ||
          saved.content?.role !== "model" ||
          !Array.isArray(saved.content.parts) ||
          !Array.isArray(saved.mirrors) ||
          !Array.isArray(saved.calls)
        )
          gFail(p, "Invalid sealed native response");
        // Preserve every original Part, including empty signed text and exact parallel order.
        contents.push(structuredClone(saved.content));
        mirrors = structuredClone(saved.mirrors);
        for (const c of saved.calls) {
          if (
            !gObject(c) ||
            typeof c.callId !== "string" ||
            !gObject(c.native) ||
            calls.has(c.callId)
          )
            gFail(p, "Duplicate native call identity in history");
          calls.set(c.callId, structuredClone(c.native));
        }
      } else if ((v.type ?? "message") === "message") {
        gFields(
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
        const blocks = parts(v.content, `${p}.content`);
        if (["system", "developer"].includes(v.role)) {
          if (contents.length)
            gFail(
              `${p}.role`,
              "Mid-history privileged instructions require an ordering-preserving contract",
            );
          if (blocks.some((x) => x.text === undefined))
            gFail(p, "System instructions require text");
          system.push(...blocks);
        } else if (v.role === "user" || v.role === "assistant")
          append(v.role === "user" ? "user" : "model", blocks);
        else gFail(`${p}.role`, "Unsupported role");
      } else if (v.type === "function_call_output") {
        gFields(v, ["type", "id", "call_id", "output", "status"], p);
        const c = calls.get(v.call_id);
        if (!c)
          gFail(
            `${p}.call_id`,
            "Result has no authenticated native function call",
          );
        // A string remains a string inside the documented arbitrary response object.
        const output =
          typeof v.output === "string"
            ? v.output
            : parts(v.output, `${p}.output`);
        append("user", [
          {
            functionResponse: {
              ...(c.id === undefined ? {} : { id: c.id }),
              name: c.name,
              response: { output },
            },
          },
        ]);
        calls.delete(v.call_id);
      } else
        gFail(
          `${p}.type`,
          "Original native function history/signature is required",
        );
    });
    if (mirrors.length) gFail("$.input", "Incomplete mirrored native history");
    if (calls.size)
      gFail("$.input", "Missing result for an original native function call");
    const native = this.model.providerModel?.gemini;
    if (!native) gFail("$.model", "Missing authoritative Gemini metadata");
    const generation: GObject = { candidateCount: 1 };
    const max = core.max_output_tokens ?? native.maxOutput;
    if (
      typeof max !== "number" ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > native.maxOutput
    )
      gFail("$.max_output_tokens", "Outside model output capabilities");
    generation.maxOutputTokens = max;
    if (core.reasoning != null) {
      if (!gObject(core.reasoning))
        gFail("$.reasoning", "Invalid reasoning configuration");
      gFields(core.reasoning, ["effort"], "$.reasoning");
      if (core.reasoning.effort != null)
        gFail(
          "$.reasoning.effort",
          "Per-model levels are not advertised by this native catalog",
        );
    }
    if (native.thinking) generation.thinkingConfig = { includeThoughts: true };
    for (const [key, target] of [
      ["temperature", "temperature"],
      ["top_p", "topP"],
    ])
      if (core[key] != null) {
        if (
          typeof core[key] !== "number" ||
          !Number.isFinite(core[key]) ||
          core[key] < 0 ||
          (key === "top_p" && core[key] > 1) ||
          (key === "temperature" &&
            (native.maxTemperature === undefined ||
              core[key] > native.maxTemperature))
        )
          gFail(
            `$.${key}`,
            "Sampling value is outside authoritative capabilities",
          );
        generation[target] = core[key];
      }
    if (core.text != null) {
      if (!gObject(core.text)) gFail("$.text", "Invalid output configuration");
      gFields(core.text, ["format"], "$.text");
      if (core.text.format?.type === "json_schema") {
        gFields(
          core.text.format,
          ["type", "name", "description", "schema", "strict"],
          "$.text.format",
        );
        generation.responseMimeType = "application/json";
        generation.responseJsonSchema = core.text.format.schema;
        try {
          this.outputValidator = this.ajv.compile(core.text.format.schema);
        } catch {
          gFail(
            "$.text.format.schema",
            "Output schema cannot be validated without weakening its contract",
          );
        }
        keep("$.text.format", core.text.format);
      } else if (core.text.format?.type !== "text")
        gFail("$.text.format", "Unsupported output format");
    }
    const declarations = (core.tools as GObject[]).map((t, i) => {
      const p = `$.tools[${i}]`;
      gFields(t, ["type", "name", "parameters", "description", "strict"], p);
      if (t.type !== "function")
        gFail(p, "Expected reversible function encoding");
      try {
        this.validators.set(t.name, this.ajv.compile(t.parameters));
      } catch {
        gFail(
          `${p}.parameters`,
          "Schema cannot be validated without weakening its contract",
        );
      }
      keep(p, t);
      return {
        name: t.name,
        parametersJsonSchema: t.parameters,
        ...(t.description === undefined ? {} : { description: t.description }),
      };
    });
    if (
      core.parallel_tool_calls != null &&
      typeof core.parallel_tool_calls !== "boolean"
    )
      gFail("$.parallel_tool_calls", "Expected boolean");
    this.parallel = core.parallel_tool_calls !== false;
    if (!this.parallel && declarations.length)
      gFail(
        "$.parallel_tool_calls",
        "Native GenerateContent has no qualified single-call constraint",
      );
    const choice = core.tool_choice ?? "auto",
      fc: GObject = {};
    if (
      typeof choice === "string" &&
      ["auto", "none", "required"].includes(choice)
    )
      fc.mode =
        choice === "none" ? "NONE" : choice === "required" ? "ANY" : "AUTO";
    else if (gObject(choice) && choice.type === "function") {
      gFields(choice, ["type", "name"], "$.tool_choice");
      fc.mode = "ANY";
      fc.allowedFunctionNames = [choice.name];
    } else gFail("$.tool_choice", "Unsupported tool choice");
    if (
      !declarations.length &&
      !(typeof choice === "string" && ["auto", "none"].includes(choice))
    )
      gFail("$.tool_choice", "Forced tool choice requires a mounted tool");
    return Buffer.from(
      JSON.stringify({
        contents,
        ...(system.length ? { systemInstruction: { parts: system } } : {}),
        generationConfig: generation,
        ...(declarations.length
          ? {
              tools: [{ functionDeclarations: declarations }],
              toolConfig: { functionCallingConfig: fc },
            }
          : {}),
      }),
    );
  }
}
