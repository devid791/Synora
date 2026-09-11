import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ResponsesToolCodec } from "./responses-tool-codec";
import { ProviderCompatibilityError } from "./responses-provider";
import { NativeHistory } from "./native-history";
import type { ModelCapabilities } from "../shared/contracts";
export type MObject = Record<string, any>;
export const mObject = (v: unknown): v is MObject =>
  !!v && typeof v === "object" && !Array.isArray(v);
export function mFail(path: string, reason: string): never {
  throw new ProviderCompatibilityError("MISTRAL_COMPATIBILITY", path, reason);
}
export function mFields(v: MObject, names: string[], path: string) {
  for (const k of Object.keys(v))
    if (!names.includes(k))
      mFail(
        `${path}.${k}`,
        "No qualified Mistral mapping; original data was not discarded",
      );
}
const string = (v: unknown, path: string): string =>
  typeof v === "string" ? v : mFail(path, "Expected text");
export function mProjection(v: MObject): MObject {
  if (v.type === "function_call") {
    mFields(
      v,
      ["id", "type", "call_id", "name", "arguments", "status"],
      "$.input",
    );
    let args;
    try {
      args = JSON.parse(v.arguments);
    } catch {
      return mFail("$.input.arguments", "Invalid original tool JSON");
    }
    return { type: v.type, call_id: v.call_id, name: v.name, arguments: args };
  }
  if ((v.type ?? "message") === "message" && v.role === "assistant") {
    mFields(
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
      "$.input",
    );
    const content =
      typeof v.content === "string"
        ? [{ type: "output_text", text: v.content }]
        : v.content;
    if (
      !Array.isArray(content) ||
      content.some(
        (x) =>
          !mObject(x) ||
          !["output_text", "input_text"].includes(x.type) ||
          typeof x.text !== "string" ||
          x.annotations?.length ||
          x.logprobs?.length,
      )
    )
      mFail("$.input.content", "Invalid native history mirror");
    for (const part of content)
      mFields(
        part,
        ["type", "text", "annotations", "logprobs"],
        "$.input.content",
      );
    return {
      type: "message",
      role: "assistant",
      text: content.map((x) => x.text).join(""),
    };
  }
  return mFail("$.input", "Unexpected native history mirror");
}

/** Core retains original call/result IDs. The nine-character native wire ID is
 * deterministic across cold history, with collision rejection (never truncation
 * of the original identity). Sealed responses retain native IDs and full content. */
export class MistralEnvelope {
  readonly tools = new ResponsesToolCodec({
    maxTools: 128,
    provider: "Mistral",
  });
  readonly metadata: { path: string; value: unknown }[] = [];
  readonly validators = new Map<string, ValidateFunction>();
  readonly historyCallIds = new Set<string>();
  outputValidator?: ValidateFunction;
  outputJson = false;
  parallel = true;
  choice: string = "auto";
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
      mFail(
        "$.tool_calls.function.name",
        "Tool is not in this request's mounted catalog",
      );
    const validate = this.validators.get(name)!;
    if (!validate(args))
      mFail(
        "$.tool_calls.function.arguments",
        `Arguments violate the original schema: ${this.ajv.errorsText(validate.errors)}`,
      );
    if (
      this.choice === "none" ||
      (this.choice !== "auto" &&
        this.choice !== "required" &&
        this.choice !== name)
    )
      mFail("$.tool_calls", "Native call violates the original tool choice");
  }
  request(raw: Buffer) {
    let source;
    try {
      source = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(raw),
      );
    } catch {
      return mFail("$", "Expected UTF-8 JSON");
    }
    if (!mObject(source))
      mFail("$", "Expected complete Core Responses request");
    mFields(
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
    if (
      source.model !== this.model.id ||
      this.model.providerModel?.provider !== "mistral" ||
      !this.model.providerModel.mistral ||
      this.model.unavailableReason
    )
      mFail(
        "$.model",
        "Request requires the selected authoritative Mistral model",
      );
    if (
      source.stream !== true ||
      source.store !== false ||
      source.previous_response_id != null ||
      (source.background != null && source.background !== false) ||
      (source.truncation != null && source.truncation !== "disabled")
    )
      mFail("$", "Core must own streaming and complete stateless history");
    if (
      source.include != null &&
      (!Array.isArray(source.include) ||
        source.include.some(
          (v: unknown) => v !== "reasoning.encrypted_content",
        ))
    )
      mFail("$.include", "Only retained native reasoning is supported");
    const core = this.tools.request(source) as MObject;
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
    // Host metadata has no model semantics; original item/result identities and
    // Core-only display fields remain inspectable, never sent as prompt text.
    keep("$.input", source.input);
    const messages: MObject[] = [],
      pending = new Map<string, string>(),
      used = new Map<string, string>();
    const nativeId = (id: unknown) => {
      if (typeof id !== "string" || !id)
        return mFail("$.input.call_id", "Missing original call identity");
      if (this.historyCallIds.has(id))
        mFail("$.input.call_id", "Duplicate original call identity");
      this.historyCallIds.add(id);
      const wire = /^[A-Za-z0-9]{9}$/.test(id)
        ? id
        : createHash("sha256")
            .update(`synora-mistral-call-v1:${id}`)
            .digest("hex")
            .slice(0, 9);
      if (used.has(wire) && used.get(wire) !== id)
        mFail("$.input.call_id", "Native call identity collision");
      used.set(wire, id);
      return wire;
    };
    const content = (value: unknown, path: string, role: string): any => {
      if (typeof value === "string") return value;
      if (!Array.isArray(value))
        return mFail(path, "Expected complete message content");
      return value.map((part, i) => {
        const p = `${path}[${i}]`;
        if (!mObject(part)) mFail(p, "Expected content part");
        if (["input_text", "output_text"].includes(part.type)) {
          mFields(part, ["type", "text", "annotations", "logprobs"], p);
          if (part.annotations?.length || part.logprobs?.length)
            mFail(p, "Annotations/logprobs require a native mapping");
          return { type: "text", text: string(part.text, p) };
        }
        if (
          part.type === "input_image" &&
          role === "user" &&
          this.model.providerModel!.inputModalities.includes("image")
        ) {
          mFields(part, ["type", "image_url", "detail"], p);
          if (part.detail != null && part.detail !== "auto")
            mFail(p, "Image detail override has no qualified native mapping");
          const url = string(part.image_url, p);
          if (
            !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
              url,
            )
          )
            mFail(p, "Inline image required; no host-side URL fetch");
          return { type: "image_url", image_url: url };
        }
        return mFail(p, "Unsupported Mistral content type");
      });
    };
    const assistant = () => {
      if (messages.at(-1)?.role !== "assistant")
        messages.push({ role: "assistant", content: [] });
      return messages.at(-1)!;
    };
    if (core.instructions != null)
      messages.push({
        role: "system",
        content: string(core.instructions, "$.instructions"),
      });
    if (!Array.isArray(core.input))
      mFail("$.input", "Expected complete Core history");
    let mirrors: MObject[] = [];
    for (const [i, v] of core.input.entries()) {
      const p = `$.input[${i}]`;
      if (!mObject(v)) mFail(p, "Expected original history item");
      if (mirrors.length) {
        if (!isDeepStrictEqual(mirrors.shift(), mProjection(v)))
          mFail(p, "Core mirror differs from authenticated native history");
        continue;
      }
      if (v.type === "reasoning") {
        mFields(
          v,
          [
            "id",
            "type",
            "summary",
            "content",
            "encrypted_content",
            "status",
            "internal_chat_message_metadata_passthrough",
          ],
          p,
        );
        if (v.encrypted_content != null) {
          let saved: any;
          try {
            saved = this.history.restore(v.encrypted_content);
          } catch {
            return mFail(
              p,
              "Cannot authenticate original Mistral history for this model/endpoint",
            );
          }
          if (
            !mObject(saved) ||
            saved.version !== 1 ||
            saved.message?.role !== "assistant" ||
            !Array.isArray(saved.mirrors)
          )
            mFail(p, "Invalid sealed Mistral history");
          const msg = structuredClone(saved.message);
          for (const call of msg.tool_calls ?? []) {
            if (pending.has(call.id))
              mFail(p, "Duplicate original call identity");
            const id = nativeId(call.id);
            pending.set(call.id, id);
            call.id = id;
          }
          messages.push(msg);
          mirrors = structuredClone(saved.mirrors);
        } else {
          const parts = v.content ?? v.summary;
          if (!Array.isArray(parts))
            mFail(p, "Plain reasoning requires original text");
          const thinking = parts.map((part: unknown) => {
            if (!mObject(part)) return mFail(p, "Invalid plain reasoning");
            mFields(part, ["type", "text"], p);
            if (!["reasoning_text", "summary_text", "text"].includes(part.type))
              mFail(p, "Unsupported reasoning content");
            return { type: "text", text: string(part.text, p) };
          });
          const msg = assistant();
          if (typeof msg.content === "string")
            msg.content = [{ type: "text", text: msg.content }];
          msg.content.push({ type: "thinking", thinking }); // No synthetic signature.
        }
      } else if ((v.type ?? "message") === "message") {
        mFields(
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
        if (!["system", "developer", "user", "assistant"].includes(v.role))
          mFail(p, "Unsupported message role");
        if (pending.size)
          mFail(p, "Original call results must precede subsequent messages");
        const role = v.role === "developer" ? "system" : v.role;
        const c = content(v.content, `${p}.content`, role);
        if (role === "assistant" && messages.at(-1)?.role === "assistant") {
          const msg = assistant();
          msg.content = [
            ...(typeof msg.content === "string"
              ? [{ type: "text", text: msg.content }]
              : msg.content),
            ...(typeof c === "string" ? [{ type: "text", text: c }] : c),
          ];
        } else messages.push({ role, content: c });
      } else if (v.type === "function_call") {
        mFields(v, ["id", "type", "call_id", "name", "arguments", "status"], p);
        const id = nativeId(v.call_id);
        if (pending.has(v.call_id))
          mFail(p, "Duplicate original call identity");
        let args;
        try {
          args = JSON.parse(v.arguments);
        } catch {
          return mFail(p, "Invalid original call JSON");
        }
        if (!mObject(args))
          mFail(p, "Original function arguments must be an object");
        pending.set(v.call_id, id);
        const msg = assistant();
        (msg.tool_calls ??= []).push({
          id,
          type: "function",
          function: { name: string(v.name, p), arguments: v.arguments },
        });
      } else if (v.type === "function_call_output") {
        mFields(v, ["type", "id", "call_id", "output", "status"], p);
        const id = pending.get(v.call_id);
        if (!id)
          mFail(p, "Result has no original function call or is duplicated");
        messages.push({
          role: "tool",
          tool_call_id: id,
          content: content(v.output, `${p}.output`, "tool"),
        });
        pending.delete(v.call_id);
      } else mFail(p, "Unsupported original history type");
    }
    if (mirrors.length || pending.size)
      mFail("$.input", "Incomplete original history mirrors or tool results");
    // Explicit usage request is documented in /resources/known-limitations.
    const body: MObject = {
      model: core.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      n: 1,
    };
    if (core.reasoning != null) {
      if (!mObject(core.reasoning))
        mFail("$.reasoning", "Invalid reasoning options");
      mFields(core.reasoning, ["effort"], "$.reasoning");
      if (core.reasoning.effort != null) {
        if (!this.model.reasoning_efforts.includes(core.reasoning.effort))
          mFail(
            "$.reasoning.effort",
            "Effort is not documented for this model",
          );
        body.reasoning_effort = core.reasoning.effort;
      }
    }
    if (core.max_output_tokens != null) {
      if (
        !Number.isSafeInteger(core.max_output_tokens) ||
        core.max_output_tokens < 1 ||
        !this.model.context_window ||
        core.max_output_tokens > this.model.context_window
      )
        mFail("$.max_output_tokens", "Invalid model token budget");
      body.max_tokens = core.max_output_tokens;
    }
    for (const k of ["temperature", "top_p"])
      if (core[k] != null) {
        if (
          typeof core[k] !== "number" ||
          !Number.isFinite(core[k]) ||
          core[k] < 0 ||
          (k === "top_p" && core[k] > 1)
        )
          mFail(`$.${k}`, "Invalid native sampling range");
        body[k] = core[k];
      }
    if (core.text != null) {
      if (!mObject(core.text)) mFail("$.text", "Invalid output configuration");
      mFields(core.text, ["format"], "$.text");
      const f = core.text.format;
      if (!mObject(f)) mFail("$.text.format", "Missing original output format");
      if (f.type === "json_schema") {
        mFields(
          f,
          ["type", "name", "description", "schema", "strict"],
          "$.text.format",
        );
        if (
          typeof f.name !== "string" ||
          !f.name ||
          !mObject(f.schema) ||
          (f.strict != null && typeof f.strict !== "boolean")
        )
          mFail("$.text.format", "Invalid original output schema");
        try {
          this.outputValidator = this.ajv.compile(f.schema);
        } catch {
          return mFail(
            "$.text.format.schema",
            "Output schema cannot be validated without weakening it",
          );
        }
        const { type, ...schema } = f;
        body.response_format = { type, json_schema: schema };
        this.outputJson = true;
      } else if (["text", "json_object"].includes(f.type)) {
        mFields(f, ["type"], "$.text.format");
        body.response_format = f;
        this.outputJson = f.type === "json_object";
      } else mFail("$.text.format", "Unsupported output format");
    }
    const tools = (core.tools as MObject[]).map((t, i) => {
      try {
        this.validators.set(t.name, this.ajv.compile(t.parameters));
      } catch {
        return mFail(
          `$.tools[${i}].parameters`,
          "Schema cannot be validated without weakening it",
        );
      }
      const { type, ...fn } = t;
      return { type, function: fn };
    });
    if (tools.length && !this.model.providerModel.mistral.functionCalling)
      mFail("$.tools", "Selected model does not support function calling");
    if (
      core.parallel_tool_calls != null &&
      typeof core.parallel_tool_calls !== "boolean"
    )
      mFail("$.parallel_tool_calls", "Expected boolean");
    this.parallel = core.parallel_tool_calls !== false;
    const choice = core.tool_choice ?? "auto";
    if (
      typeof choice === "string" &&
      ["auto", "none", "required"].includes(choice)
    ) {
      body.tool_choice = choice;
      this.choice = choice;
    } else if (mObject(choice) && choice.type === "function") {
      mFields(choice, ["type", "name"], "$.tool_choice");
      body.tool_choice = { type: "function", function: { name: choice.name } };
      this.choice = choice.name;
    } else mFail("$.tool_choice", "Unsupported tool choice");
    if (!tools.length && !["auto", "none"].includes(this.choice))
      mFail("$.tool_choice", "Forced choice requires mounted tools");
    if (tools.length) {
      body.tools = tools;
      body.parallel_tool_calls = this.parallel;
    }
    return Buffer.from(JSON.stringify(body));
  }
}
