import { randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import {
  MistralEnvelope,
  mObject,
  mFields,
  mFail,
  mProjection,
  type MObject,
} from "./mistral-envelope";

// Native schemas: mistralai/client-ts src/models/components/{completionchunk,
// completionresponsestreamchoice,deltamessage,thinkchunk,usageinfo}.ts.
// Native SSE is converted here; framing/backpressure/auth/cancel and reversible
// Core namespace/custom events remain owned by the shared Responses bridge.
type Call = {
  index: number;
  id: string;
  name: string;
  args: string;
  emitted: number;
  item?: MObject;
};
export class MistralStream extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private bytes = 0;
  private seq = 0;
  private response?: MObject;
  private nativeModel?: string;
  private outputs: MObject[] = [];
  private content: MObject[] = [];
  private calls = new Map<number, Call>();
  private frames: MObject[] = [];
  private usage?: MObject;
  private finish?: string;
  private error?: MObject;
  private done = false;
  private summary = "";
  private summaryStarted = false;
  private lastMessage?: MObject;
  constructor(private envelope: MistralEnvelope) {
    super();
  }
  private emitEvent(type: string, value: MObject = {}) {
    this.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...value })}\n\n`,
    );
  }
  private ref(item: MObject) {
    return { item_id: item.id, output_index: this.outputs.indexOf(item) + 1 };
  }
  private reasonRef() {
    return {
      item_id: `rs_${this.response!.id}`,
      output_index: 0,
      summary_index: 0,
    };
  }
  private start(frame: MObject) {
    if (this.response) return;
    if (
      typeof frame.id !== "string" ||
      !frame.id ||
      typeof frame.model !== "string" ||
      !frame.model
    )
      mFail(
        "$.sse",
        "Native stream must announce its response and model identities",
      );
    if (
      frame.created !== undefined &&
      (!Number.isSafeInteger(frame.created) || frame.created < 0)
    )
      mFail("$.created", "Invalid native creation timestamp");
    this.nativeModel = frame.model;
    this.response = {
      id: frame.id,
      object: "response",
      model: frame.model,
      created_at: frame.created ?? Math.floor(Date.now() / 1000),
      status: "in_progress",
      output: [],
    };
    this.emitEvent("response.created", { response: this.response });
    this.emitEvent("response.in_progress", { response: this.response });
    this.emitEvent("response.output_item.added", {
      output_index: 0,
      item: {
        id: `rs_${frame.id}`,
        type: "reasoning",
        summary: [],
        encrypted_content: null,
      },
    });
  }
  private text(text: string) {
    if (!text) return;
    if (!this.lastMessage) {
      this.lastMessage = {
        id: `msg_${this.response!.id}_${this.outputs.length}`,
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      this.outputs.push(this.lastMessage);
      this.emitEvent("response.output_item.added", {
        ...this.ref(this.lastMessage),
        item: { ...this.lastMessage, content: [] },
      });
      this.emitEvent("response.content_part.added", {
        ...this.ref(this.lastMessage),
        content_index: 0,
        part: structuredClone(this.lastMessage.content[0]),
      });
    }
    this.lastMessage.content[0].text += text;
    this.emitEvent("response.output_text.delta", {
      ...this.ref(this.lastMessage),
      content_index: 0,
      delta: text,
    });
  }
  private part(part: unknown) {
    if (!mObject(part))
      mFail("$.delta.content", "Expected native content chunk");
    if (part.type === "text") {
      mFields(part, ["type", "text"], "$.delta.content");
      if (typeof part.text !== "string")
        mFail("$.delta.content.text", "Expected text delta");
      // Keep exact TextChunk boundaries in sealed history, including empty text.
      this.content.push(structuredClone(part));
      this.text(part.text);
    } else if (part.type === "thinking") {
      mFields(
        part,
        ["type", "thinking", "signature", "closed"],
        "$.delta.content",
      );
      if (
        !Array.isArray(part.thinking) ||
        (part.signature != null && typeof part.signature !== "string") ||
        (part.closed !== undefined && typeof part.closed !== "boolean")
      )
        mFail("$.delta.content", "Invalid native ThinkChunk");
      for (const inner of part.thinking) {
        if (
          !mObject(inner) ||
          inner.type !== "text" ||
          typeof inner.text !== "string"
        )
          mFail(
            "$.thinking",
            "Thinking reference chunks require an explicit display mapping",
          );
        mFields(inner, ["type", "text"], "$.thinking");
      }
      // Deltas extend the current ThinkChunk until closed, not independent signed
      // thoughts. Keep exact nested TextChunks; only a supplied signature is used.
      const prior = this.content.at(-1);
      if (prior?.type === "thinking" && prior.closed !== true) {
        if (
          prior.signature != null &&
          part.signature != null &&
          prior.signature !== part.signature
        )
          mFail(
            "$.signature",
            "Native thinking signature changed before the block closed",
          );
        prior.thinking.push(...structuredClone(part.thinking));
        if (part.signature != null || prior.signature === undefined)
          if (part.signature !== undefined) prior.signature = part.signature;
        if (part.closed !== undefined) prior.closed = part.closed;
      } else this.content.push(structuredClone(part));
      if (!this.summaryStarted) {
        this.summaryStarted = true;
        this.emitEvent("response.reasoning_summary_part.added", {
          ...this.reasonRef(),
          part: { type: "summary_text", text: "" },
        });
      }
      for (const inner of part.thinking) {
        this.summary += inner.text;
        if (inner.text)
          this.emitEvent("response.reasoning_summary_text.delta", {
            ...this.reasonRef(),
            delta: inner.text,
          });
      }
      this.lastMessage = undefined;
    } else
      mFail(
        "$.delta.content.type",
        "Unsupported native content; no text or input was discarded",
      );
  }
  private call(delta: unknown) {
    if (
      !mObject(delta) ||
      !Number.isSafeInteger(delta.index) ||
      delta.index < 0 ||
      !mObject(delta.function)
    )
      mFail("$.tool_calls", "Expected indexed native function delta");
    mFields(delta, ["index", "id", "type", "function"], "$.tool_calls");
    mFields(delta.function, ["name", "arguments"], "$.tool_calls.function");
    if (delta.type !== undefined && delta.type !== "function")
      mFail("$.tool_calls.type", "Unsupported native tool type");
    let c = this.calls.get(delta.index);
    if (!c) {
      if (!this.envelope.parallel && this.calls.size)
        mFail(
          "$.tool_calls",
          "Native response violates the single-call constraint",
        );
      c = { index: delta.index, id: "", name: "", args: "", emitted: 0 };
      this.calls.set(delta.index, c);
    }
    if (delta.id !== undefined && delta.id !== null && delta.id !== "") {
      if (typeof delta.id !== "string" || (c.id && c.id !== delta.id))
        mFail("$.tool_calls.id", "Original native call identity changed");
      c.id = delta.id;
      if (c.id === "null" || this.envelope.historyCallIds.has(c.id))
        mFail(
          "$.tool_calls.id",
          "Native call reused an invalid or historical identity",
        );
      if ([...this.calls.values()].some((x) => x !== c && x.id === c!.id))
        mFail("$.tool_calls.id", "Duplicate original call identity");
    }
    if (delta.function.name != null && delta.function.name !== "") {
      if (typeof delta.function.name !== "string")
        mFail("$.tool_calls.function.name", "Invalid native function name");
      if (c.item && delta.function.name !== c.name)
        mFail(
          "$.tool_calls.function.name",
          "Announced function identity changed",
        );
      if (!c.item) c.name += delta.function.name;
    }
    if (delta.function.arguments != null) {
      if (typeof delta.function.arguments !== "string")
        mFail(
          "$.tool_calls.function.arguments",
          "Streaming arguments must be a JSON string",
        );
      c.args += delta.function.arguments;
    }
    if (!c.item && c.id && this.envelope.validators.has(c.name)) {
      c.item = {
        id: `fc_${this.response!.id}_${c.index}`,
        type: "function_call",
        call_id: c.id,
        name: c.name,
        arguments: "",
        status: "in_progress",
      };
      this.outputs.push(c.item);
      this.emitEvent("response.output_item.added", {
        ...this.ref(c.item),
        item: structuredClone(c.item),
      });
    }
    if (c.item && c.emitted < c.args.length) {
      c.item.arguments = c.args;
      this.emitEvent("response.function_call_arguments.delta", {
        ...this.ref(c.item),
        delta: c.args.slice(c.emitted),
      });
      c.emitted = c.args.length;
    }
    this.lastMessage = undefined;
  }
  private chunk(frame: unknown) {
    if (!mObject(frame)) mFail("$.sse", "Expected native JSON object");
    if (this.done || this.error)
      mFail("$.sse", "Native data after terminal response");
    // `p` is documented security padding (2025-08-27 changelog), not content.
    mFields(
      frame,
      ["id", "object", "created", "model", "choices", "usage", "error", "p"],
      "$.sse",
    );
    if (frame.error != null) {
      if (!mObject(frame.error)) mFail("$.error", "Invalid native error");
      this.start({
        id: frame.id ?? `synora_mistral_error_${randomUUID()}`,
        model: frame.model ?? this.envelope.model.id,
        created: frame.created,
      });
      this.error = structuredClone(frame.error);
      return;
    }
    this.start(frame);
    if (frame.id !== this.response!.id || frame.model !== this.nativeModel)
      mFail("$.sse", "Native response/model identity changed");
    if (
      frame.created !== undefined &&
      frame.created !== this.response!.created_at
    )
      mFail("$.created", "Native timestamp changed");
    if (!Array.isArray(frame.choices) || frame.choices.length > 1)
      mFail("$.choices", "Expected the requested single choice");
    this.frames.push(structuredClone(frame));
    if (frame.usage != null) {
      if (!mObject(frame.usage)) mFail("$.usage", "Invalid native usage");
      for (const key of [
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
      ]) {
        const n = frame.usage[key];
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
          mFail(`$.usage.${key}`, "Invalid measured token count");
        if (
          n !== undefined &&
          this.usage?.[key] !== undefined &&
          n < this.usage[key]
        )
          mFail(`$.usage.${key}`, "Native cumulative usage regressed");
      }
      this.usage = { ...this.usage, ...frame.usage };
      const u = this.usage!;
      if (
        ["prompt_tokens", "completion_tokens", "total_tokens"].every(
          (k) => u[k] !== undefined,
        ) &&
        u.prompt_tokens + u.completion_tokens !== u.total_tokens
      )
        mFail("$.usage", "Native token totals disagree");
    }
    if (!frame.choices.length) return;
    const c = frame.choices[0];
    if (!mObject(c) || c.index !== 0 || !mObject(c.delta))
      mFail("$.choices", "Invalid single-choice identity/delta");
    mFields(c, ["index", "delta", "finish_reason"], "$.choices[0]");
    if (this.finish)
      mFail("$.choices", "Choice arrived after its finish reason");
    const d = c.delta;
    mFields(
      d,
      ["role", "content", "tool_calls", "tool_call_id", "index", "metadata"],
      "$.delta",
    );
    if (
      (d.role != null && d.role !== "assistant") ||
      (d.index != null && d.index !== 0) ||
      d.tool_call_id != null
    )
      mFail("$.delta", "Unsupported native message identity/role");
    if (d.metadata != null && !mObject(d.metadata))
      mFail("$.delta.metadata", "Invalid native metadata");
    if (d.content != null) {
      if (typeof d.content === "string")
        this.part({ type: "text", text: d.content });
      else if (Array.isArray(d.content))
        for (const p of d.content) this.part(p);
      else mFail("$.delta.content", "Expected string or native chunk array");
    }
    if (d.tool_calls != null) {
      if (!Array.isArray(d.tool_calls))
        mFail("$.delta.tool_calls", "Expected indexed native calls");
      for (const call of d.tool_calls) this.call(call);
    }
    if (c.finish_reason != null) {
      if (typeof c.finish_reason !== "string" || !c.finish_reason)
        mFail("$.finish_reason", "Invalid finish reason");
      this.finish = c.finish_reason;
    }
  }
  private terminal() {
    if (this.done) mFail("$.sse", "Duplicate native terminal marker");
    if (!this.response || (!this.finish && !this.error))
      mFail("$.sse", "Native stream ended without a finish reason");
    const status =
      this.error ||
      !["stop", "tool_calls", "length", "model_length"].includes(this.finish!)
        ? "failed"
        : ["length", "model_length"].includes(this.finish!)
          ? "incomplete"
          : "completed";
    if (status === "completed") {
      if ((this.finish === "tool_calls") !== !!this.calls.size)
        mFail(
          "$.finish_reason",
          "Native tool finish reason disagrees with actual calls",
        );
      if (
        this.envelope.choice !== "auto" &&
        this.envelope.choice !== "none" &&
        !this.calls.size
      )
        mFail("$.tool_calls", "Native response omitted a required tool call");
      for (const c of this.calls.values()) {
        let args;
        try {
          args = JSON.parse(c.args);
        } catch {
          return mFail(
            "$.tool_calls.function.arguments",
            "Truncated or invalid native tool JSON",
          );
        }
        this.envelope.validateCall(c.name, args);
        if (!c.item || !c.id)
          mFail("$.tool_calls", "Native call lacks original identity");
      }
      if (this.envelope.outputJson && !this.calls.size) {
        let value;
        try {
          value = JSON.parse(
            this.outputs
              .filter((x) => x.type === "message")
              .map((x) => x.content[0].text)
              .join(""),
          );
        } catch {
          return mFail(
            "$.output",
            "Native response violates the requested JSON contract",
          );
        }
        if (
          this.envelope.outputValidator &&
          !this.envelope.outputValidator(value)
        )
          mFail(
            "$.output",
            "Native response violates the original output schema",
          );
      }
    }
    if (this.summaryStarted) {
      this.emitEvent("response.reasoning_summary_text.done", {
        ...this.reasonRef(),
        text: this.summary,
      });
      this.emitEvent("response.reasoning_summary_part.done", {
        ...this.reasonRef(),
        part: { type: "summary_text", text: this.summary },
      });
    }
    const message: MObject = { role: "assistant", content: this.content };
    if (this.calls.size)
      message.tool_calls = [...this.calls.values()].map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args },
      }));
    const marker: MObject = {
      id: `rs_${this.response.id}`,
      type: "reasoning",
      summary: this.summaryStarted
        ? [{ type: "summary_text", text: this.summary }]
        : [],
    };
    // Incomplete tool calls cannot be executed/replayed as successful history.
    // Terminal partial output remains visible, but no fake sealed success exists.
    if (
      status === "completed" ||
      (status === "incomplete" && !this.calls.size)
    ) {
      marker.encrypted_content = this.envelope.history.seal({
        version: 1,
        message,
        mirrors: this.outputs.map(mProjection),
        frames: this.frames,
      });
    }
    this.emitEvent("response.output_item.done", {
      output_index: 0,
      item: marker,
    });
    for (const item of this.outputs) {
      item.status = status === "completed" ? "completed" : "incomplete";
      if (item.type === "function_call") {
        if (status !== "completed") continue; // Never dispatch an incomplete tool.
        this.emitEvent("response.function_call_arguments.done", {
          ...this.ref(item),
          arguments: item.arguments,
        });
      } else {
        this.emitEvent("response.output_text.done", {
          ...this.ref(item),
          content_index: 0,
          text: item.content[0].text,
        });
        this.emitEvent("response.content_part.done", {
          ...this.ref(item),
          content_index: 0,
          part: item.content[0],
        });
      }
      this.emitEvent("response.output_item.done", { ...this.ref(item), item });
    }
    const u = this.usage;
    this.emitEvent(`response.${status}`, {
      response: {
        ...this.response,
        status,
        output: [marker, ...this.outputs],
        ...(status === "incomplete"
          ? {
              incomplete_details: {
                reason:
                  this.finish === "model_length"
                    ? "context_window_exceeded"
                    : "max_output_tokens",
              },
            }
          : {}),
        ...(status === "failed"
          ? {
              error: {
                code: `MISTRAL_${this.finish ?? "error"}`,
                message: "Native Mistral did not complete successfully",
              },
            }
          : {}),
        ...(u &&
        ["prompt_tokens", "completion_tokens", "total_tokens"].every(
          (k) => u[k] !== undefined,
        )
          ? {
              usage: {
                input_tokens: u.prompt_tokens,
                output_tokens: u.completion_tokens,
                total_tokens: u.total_tokens,
              },
            }
          : {}),
      },
    });
    this.done = true;
  }
  private framesFromPending(final = false) {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (frame.length > 8 * 1024 * 1024)
        mFail("$.sse", "Native SSE frame exceeds transport bound");
      const lines = frame.split(/\r?\n/),
        data = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        this.terminal();
        continue;
      }
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return mFail("$.sse", "Malformed native JSON event");
      }
      this.chunk(json);
    }
    if (this.pending.length > 8 * 1024 * 1024)
      mFail("$.sse", "Native SSE frame exceeds transport bound");
    if (final && this.pending.trim())
      mFail("$.sse", "Truncated native SSE frame");
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      this.bytes += chunk.length;
      if (this.bytes > 64 * 1024 * 1024)
        mFail("$.sse", "Native response exceeds transport bound");
      this.pending += this.decoder.decode(chunk, { stream: true });
      this.framesFromPending();
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
  override _flush(callback: TransformCallback) {
    try {
      this.pending += this.decoder.decode();
      this.framesFromPending(true);
      if (!this.done && this.error) this.terminal();
      if (!this.done)
        mFail("$.sse", "Native stream closed without its terminal marker");
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
}
