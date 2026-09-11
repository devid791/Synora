import { Transform, type TransformCallback } from "node:stream";
import {
  AnthropicEnvelope,
  anthropicFail as fail,
  fields,
  isObject,
  nativeThinking,
  type NativeObject,
} from "./anthropic-envelope";
/** Native Messages -> ordered Responses. Completion requires message_stop and
 * closed blocks; HTTP200, an error, a token cap or a truncated socket is not success. */
export class AnthropicStream extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private seq = 0;
  private response?: NativeObject;
  private usage: NativeObject = {};
  private stopped = false;
  private stopReason?: string;
  private blocks = new Map<
    number,
    {
      native: NativeObject;
      item: NativeObject;
      raw: string;
      closed: boolean;
      initial: boolean;
    }
  >();
  private callIds = new Set<string>();
  private bytes = 0;
  constructor(private envelope: AnthropicEnvelope) {
    super();
  }
  private emitEvent(type: string, value: NativeObject = {}) {
    this.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...value })}\n\n`,
    );
  }
  private indexed(index: number, item: NativeObject) {
    return { item_id: item.id, output_index: index };
  }
  private event(e: NativeObject) {
    if (this.stopped) fail("$.sse", "Native event after terminal message");
    if (e.type === "ping") {
      this.push(": anthropic ping\n\n");
      return;
    }
    if (e.type === "error") {
      // No provider error content/credentials leaked through a stream exception.
      if (!this.response)
        fail("$.sse.error", "Native provider failed before message_start");
      this.emitEvent("response.failed", {
        response: {
          ...this.response,
          status: "failed",
          error: {
            code: "ANTHROPIC_UPSTREAM",
            message: "Native provider emitted an error",
          },
        },
      });
      this.stopped = true;
      return;
    }
    if (e.type === "message_start") {
      if (
        this.response ||
        !isObject(e.message) ||
        typeof e.message.id !== "string" ||
        !e.message.id ||
        e.message.role !== "assistant" ||
        e.message.type !== "message" ||
        e.message.model !== this.envelope.model.id ||
        !Array.isArray(e.message.content) ||
        e.message.content.length
      )
        fail("$.message_start", "Invalid or duplicate native message identity");
      this.response = {
        id: e.message.id,
        object: "response",
        model: e.message.model,
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        output: [],
      };
      this.mergeUsage(e.message.usage);
      this.emitEvent("response.created", { response: this.response });
      this.emitEvent("response.in_progress", { response: this.response });
      return;
    }
    if (!this.response) fail("$.sse", "Native event before message_start");
    if (e.type === "content_block_start") {
      const n = e.index,
        b = e.content_block;
      if (
        this.stopReason ||
        !Number.isSafeInteger(n) ||
        n !== this.blocks.size ||
        !isObject(b)
      )
        fail("$.content_block_start", "Invalid native content ordering");
      let item: NativeObject;
      const id = `${b.type === "thinking" || b.type === "redacted_thinking" ? "rs" : b.type === "tool_use" ? "fc" : "msg"}_${this.response.id}_${n}`;
      if (b.type === "text") {
        fields(b, ["type", "text", "citations"], "$.content_block");
        if (typeof b.text !== "string" || b.citations?.length)
          fail("$.content_block", "Unsupported native text or citations");
        item = {
          id,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [{ type: "output_text", text: "", annotations: [] }],
        };
      } else if (b.type === "tool_use") {
        fields(b, ["type", "id", "name", "input"], "$.content_block");
        if (
          typeof b.id !== "string" ||
          !/^[\w-]+$/.test(b.id) ||
          this.callIds.has(b.id) ||
          typeof b.name !== "string" ||
          !isObject(b.input)
        )
          fail("$.content_block", "Invalid or repeated native tool identity");
        this.callIds.add(b.id);
        item = {
          id,
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: "",
          status: "in_progress",
        };
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        if (b.type === "thinking") {
          fields(b, ["type", "thinking", "signature"], "$.content_block");
          if (typeof b.thinking !== "string" || typeof b.signature !== "string")
            fail("$.content_block", "Malformed native thinking");
        } else nativeThinking(b);
        item = { id, type: "reasoning", summary: [], encrypted_content: null };
      } else
        return fail(
          "$.content_block.type",
          "Native output block has no verified Core representation",
        );
      const block = {
        native: structuredClone(b),
        item,
        raw: "",
        closed: false,
        initial: false,
      };
      this.blocks.set(n, block);
      this.emitEvent("response.output_item.added", {
        output_index: n,
        item: structuredClone(item),
      });
      const ref = this.indexed(n, item);
      if (b.type === "text") {
        this.emitEvent("response.content_part.added", {
          ...ref,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
        if (b.text) {
          item.content[0].text = b.text;
          this.emitEvent("response.output_text.delta", {
            ...ref,
            content_index: 0,
            delta: b.text,
          });
        }
      } else if (b.type === "thinking") {
        item.summary = [{ type: "summary_text", text: b.thinking }];
        this.emitEvent("response.reasoning_summary_part.added", {
          ...ref,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
        if (b.thinking)
          this.emitEvent("response.reasoning_summary_text.delta", {
            ...ref,
            summary_index: 0,
            delta: b.thinking,
          });
      } else if (b.type === "tool_use" && Object.keys(b.input).length) {
        block.initial = true;
        block.raw = JSON.stringify(b.input);
        item.arguments = block.raw;
        this.emitEvent("response.function_call_arguments.delta", {
          ...ref,
          delta: block.raw,
        });
      }
      return;
    }
    if (e.type === "content_block_delta" || e.type === "content_block_stop") {
      const b = this.blocks.get(e.index);
      if (!b || b.closed || this.stopReason)
        fail(
          "$.content_block_delta",
          "Delta/stop does not belong to an open native block",
        );
      const ref = this.indexed(e.index, b.item);
      if (e.type === "content_block_delta") {
        const d = e.delta;
        if (!isObject(d)) fail("$.delta", "Expected native delta");
        if (d.type === "text_delta" && b.native.type === "text") {
          fields(d, ["type", "text"], "$.delta");
          if (typeof d.text !== "string")
            fail("$.delta.text", "Expected text delta");
          b.native.text += d.text;
          b.item.content[0].text += d.text;
          this.emitEvent("response.output_text.delta", {
            ...ref,
            content_index: 0,
            delta: d.text,
          });
        } else if (
          d.type === "input_json_delta" &&
          b.native.type === "tool_use"
        ) {
          fields(d, ["type", "partial_json"], "$.delta");
          if (typeof d.partial_json !== "string" || b.initial)
            fail(
              "$.delta.partial_json",
              "Invalid native tool argument fragments",
            );
          b.raw += d.partial_json;
          b.item.arguments = b.raw;
          if (b.raw.length > 4 * 1024 * 1024)
            fail(
              "$.delta.partial_json",
              "Tool arguments exceed transport memory bound",
            );
          this.emitEvent("response.function_call_arguments.delta", {
            ...ref,
            delta: d.partial_json,
          });
        } else if (
          d.type === "thinking_delta" &&
          b.native.type === "thinking"
        ) {
          fields(d, ["type", "thinking"], "$.delta");
          if (typeof d.thinking !== "string" || b.native.signature)
            fail("$.delta", "Thinking delta after signature or malformed text");
          b.native.thinking += d.thinking;
          b.item.summary[0].text += d.thinking;
          this.emitEvent("response.reasoning_summary_text.delta", {
            ...ref,
            summary_index: 0,
            delta: d.thinking,
          });
        } else if (
          d.type === "signature_delta" &&
          b.native.type === "thinking"
        ) {
          fields(d, ["type", "signature"], "$.delta");
          if (typeof d.signature !== "string")
            fail("$.delta.signature", "Invalid signature fragment");
          b.native.signature += d.signature;
        } else
          fail(
            "$.delta.type",
            "Native delta does not match its block or is unsupported",
          );
      } else {
        if (b.native.type === "tool_use") {
          if (!b.raw) {
            b.raw = "{}";
            this.emitEvent("response.function_call_arguments.delta", {
              ...ref,
              delta: b.raw,
            });
          }
          let input;
          try {
            input = JSON.parse(b.raw);
          } catch {
            return fail(
              "$.tool_use.input",
              "Native tool stream ended with invalid JSON",
            );
          }
          if (!isObject(input))
            fail("$.tool_use.input", "Native tool arguments must be an object");
          b.item.arguments = b.raw;
          b.item.status = "completed";
          this.emitEvent("response.function_call_arguments.done", {
            ...ref,
            arguments: b.raw,
          });
        } else if (b.native.type === "text") {
          b.item.status = "completed";
          this.emitEvent("response.output_text.done", {
            ...ref,
            content_index: 0,
            text: b.native.text,
          });
          this.emitEvent("response.content_part.done", {
            ...ref,
            content_index: 0,
            part: b.item.content[0],
          });
        } else {
          b.item.encrypted_content = this.envelope.history.seal(
            nativeThinking(b.native),
          );
          if (b.native.type === "thinking") {
            this.emitEvent("response.reasoning_summary_text.done", {
              ...ref,
              summary_index: 0,
              text: b.native.thinking,
            });
            this.emitEvent("response.reasoning_summary_part.done", {
              ...ref,
              summary_index: 0,
              part: b.item.summary[0],
            });
          }
        }
        b.closed = true;
        this.emitEvent("response.output_item.done", {
          output_index: e.index,
          item: b.item,
        });
      }
      return;
    }
    if (e.type === "message_delta") {
      if (
        this.stopReason ||
        [...this.blocks.values()].some((b) => !b.closed) ||
        !isObject(e.delta) ||
        typeof e.delta.stop_reason !== "string"
      )
        fail(
          "$.message_delta",
          "Native terminal metadata is missing, duplicated or out of order",
        );
      fields(
        e.delta,
        ["stop_reason", "stop_sequence", "container"],
        "$.message_delta.delta",
      );
      if (e.delta.container != null)
        fail(
          "$.message_delta.container",
          "Provider-managed containers are not a Core local tool result",
        );
      this.stopReason = e.delta.stop_reason;
      this.mergeUsage(e.usage);
      return;
    }
    if (e.type === "message_stop") {
      if (!this.stopReason || [...this.blocks.values()].some((b) => !b.closed))
        fail("$.message_stop", "Native stream has no finished message");
      const complete = [
        "end_turn",
        "stop_sequence",
        "tool_use",
        "refusal",
      ].includes(this.stopReason);
      if (this.stopReason === "tool_use" && !this.callIds.size)
        fail("$.stop_reason", "Native tool turn has no tool calls");
      if (this.callIds.size && this.stopReason !== "tool_use")
        fail(
          "$.stop_reason",
          "Native tool output did not complete a tool-use turn",
        );
      if (
        !complete &&
        !["max_tokens", "model_context_window_exceeded", "pause_turn"].includes(
          this.stopReason,
        )
      )
        fail("$.stop_reason", "Unknown native stop semantics");
      if (
        !Number.isSafeInteger(this.usage.input_tokens) ||
        !Number.isSafeInteger(this.usage.output_tokens)
      )
        fail("$.usage", "Native message omitted token usage");
      const cached = this.usage.cache_read_input_tokens ?? 0,
        input =
          this.usage.input_tokens +
          cached +
          (this.usage.cache_creation_input_tokens ?? 0),
        output = this.usage.output_tokens;
      const response = {
        ...this.response,
        status: complete ? "completed" : "incomplete",
        output: [...this.blocks.values()].map((b) => b.item),
        usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
          input_tokens_details: { cached_tokens: cached },
        },
        ...(!complete
          ? {
              incomplete_details: {
                reason:
                  this.stopReason === "max_tokens"
                    ? "max_output_tokens"
                    : `anthropic_${this.stopReason}`,
              },
            }
          : {}),
      };
      this.emitEvent(complete ? "response.completed" : "response.incomplete", {
        response,
      });
      this.stopped = true;
      return;
    }
    fail(
      "$.sse.type",
      "Unknown native event; no successful completion was fabricated",
    );
  }
  private mergeUsage(value: unknown) {
    if (value == null) return;
    if (!isObject(value)) fail("$.usage", "Invalid native usage");
    for (const k of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ])
      if (value[k] != null) {
        if (!Number.isSafeInteger(value[k]) || value[k] < 0)
          fail(`$.usage.${k}`, "Invalid native token count");
        this.usage[k] = value[k];
      }
  }
  private frames(final = false) {
    if (this.pending.length > 8 * 1024 * 1024)
      fail("$.sse", "Native frame exceeds transport memory bound");
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data: string[] = [];
      let type: string | undefined;
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("data:"))
          data.push(line.slice(5).replace(/^ /, ""));
        if (line.startsWith("event:")) type = line.slice(6).replace(/^ /, "");
      }
      if (!data.length) {
        this.push(": anthropic keepalive\n\n");
        continue;
      }
      let event;
      try {
        event = JSON.parse(data.join("\n"));
      } catch {
        return fail("$.sse.data", "Malformed native SSE JSON");
      }
      if (
        !isObject(event) ||
        typeof event.type !== "string" ||
        (type && type !== event.type)
      )
        fail("$.sse.event", "Native SSE event/type mismatch");
      this.event(event);
    }
    if (final && (this.pending.trim() || !this.stopped))
      fail("$.sse", "Native stream ended before a complete terminal event");
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      this.bytes += chunk.length;
      if (this.bytes > 64 * 1024 * 1024)
        fail("$.sse", "Native response exceeds transport memory bound");
      this.pending += this.decoder.decode(chunk, { stream: true });
      this.frames();
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
  override _flush(callback: TransformCallback) {
    try {
      this.pending += this.decoder.decode();
      this.frames(true);
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
}
