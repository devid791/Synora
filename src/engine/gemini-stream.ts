import { randomUUID } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import {
  GeminiEnvelope,
  gObject,
  gFields,
  gFail,
  projection,
  type GObject,
} from "./gemini-envelope";
/** A complete native Content is sealed separately from its Core display/tool
 * mirrors. No concatenation or synthetic signatures in replayed native Parts. */
export class GeminiStream extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private bytes = 0;
  private seq = 0;
  private response?: GObject;
  private providerId?: string;
  private outputs: GObject[] = [];
  private parts: GObject[] = [];
  private calls: { callId: string; native: GObject }[] = [];
  private frames: GObject[] = [];
  private usage: GObject = {};
  private finish?: string;
  private blocked?: string;
  private summary = "";
  private lastMessage?: GObject;
  constructor(private envelope: GeminiEnvelope) {
    super();
  }
  private emitEvent(type: string, value: GObject = {}) {
    this.push(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...value })}\n\n`,
    );
  }
  private ref(item: GObject) {
    return { item_id: item.id, output_index: this.outputs.indexOf(item) + 1 };
  }
  private start(frame: GObject) {
    if (this.response) return;
    if (
      frame.responseId !== undefined &&
      (typeof frame.responseId !== "string" || !frame.responseId)
    )
      gFail("$.responseId", "Invalid native response identity");
    this.providerId = frame.responseId;
    const id = frame.responseId ?? `synora_gemini_${randomUUID()}`;
    this.response = {
      id,
      object: "response",
      model: this.envelope.model.id,
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      output: [],
    };
    this.emitEvent("response.created", { response: this.response });
    this.emitEvent("response.in_progress", { response: this.response });
    this.emitEvent("response.output_item.added", {
      output_index: 0,
      item: {
        type: "reasoning",
        id: `rs_${id}`,
        summary: [],
        encrypted_content: null,
      },
    });
  }
  private chunk(frame: GObject) {
    if (!gObject(frame)) gFail("$.sse", "Expected native response object");
    gFields(
      frame,
      [
        "candidates",
        "promptFeedback",
        "usageMetadata",
        "modelVersion",
        "responseId",
        "modelStatus",
        "error",
      ],
      "$.sse",
    );
    this.start(frame);
    if (frame.responseId !== undefined) {
      if (this.providerId !== undefined && frame.responseId !== this.providerId)
        gFail("$.responseId", "Native response identity changed");
      if (this.providerId === undefined)
        gFail(
          "$.responseId",
          "Native response identity appeared after stream identity was assigned",
        );
    }
    if (frame.error) {
      this.blocked = "NATIVE_ERROR";
      return;
    }
    if (
      frame.promptFeedback?.blockReason &&
      frame.promptFeedback.blockReason !== "BLOCK_REASON_UNSPECIFIED"
    )
      this.blocked = frame.promptFeedback.blockReason;
    const { candidates: nativeCandidates, ...nativeMetadata } = frame;
    this.frames.push(
      structuredClone({
        ...nativeMetadata,
        candidates: nativeCandidates?.map(
          ({ content, ...meta }: GObject) => meta,
        ),
      }),
    );
    if (frame.usageMetadata !== undefined) {
      if (!gObject(frame.usageMetadata))
        gFail("$.usageMetadata", "Invalid usage");
      for (const k of [
        "promptTokenCount",
        "candidatesTokenCount",
        "thoughtsTokenCount",
        "totalTokenCount",
        "cachedContentTokenCount",
      ]) {
        const n = frame.usageMetadata[k];
        if (n !== undefined && (!Number.isSafeInteger(n) || n < 0))
          gFail(`$.usageMetadata.${k}`, "Invalid measured token count");
      }
      this.usage = { ...this.usage, ...frame.usageMetadata };
    }
    if (frame.candidates === undefined) return;
    if (!Array.isArray(frame.candidates) || frame.candidates.length > 1)
      gFail("$.candidates", "Expected the requested single candidate");
    if (!frame.candidates.length) return;
    const c = frame.candidates[0];
    if (!gObject(c) || (c.index !== undefined && c.index !== 0))
      gFail("$.candidates[0]", "Invalid candidate identity");
    gFields(
      c,
      [
        "index",
        "content",
        "finishReason",
        "finishMessage",
        "safetyRatings",
        "citationMetadata",
        "groundingMetadata",
        "avgLogprobs",
        "logprobsResult",
        "tokenCount",
        "urlContextMetadata",
      ],
      "$.candidates[0]",
    );
    if (
      c.citationMetadata ||
      c.groundingMetadata ||
      c.urlContextMetadata ||
      c.logprobsResult
    )
      gFail(
        "$.candidates[0]",
        "Native citations/grounding/logprobs need explicit display mapping",
      );
    if (this.finish && (c.content?.parts?.length || c.finishReason))
      gFail("$.candidates[0]", "Candidate content after its terminal reason");
    if (c.content !== undefined) {
      if (
        !gObject(c.content) ||
        (c.content.role !== undefined && c.content.role !== "model") ||
        !Array.isArray(c.content.parts)
      )
        gFail("$.content", "Invalid native model Content");
      gFields(c.content, ["role", "parts"], "$.content");
      for (const part of c.content.parts) this.part(part);
    }
    if (c.finishReason && c.finishReason !== "FINISH_REASON_UNSPECIFIED") {
      if (typeof c.finishReason !== "string")
        gFail("$.finishReason", "Invalid terminal reason");
      this.finish = c.finishReason;
    }
  }
  private part(part: unknown) {
    if (this.blocked)
      gFail("$.content", "Content arrived after native failure");
    if (!gObject(part)) gFail("$.content.parts", "Invalid native Part");
    gFields(
      part,
      ["text", "thought", "thoughtSignature", "functionCall"],
      "$.content.parts",
    );
    if (part.thought !== undefined && typeof part.thought !== "boolean")
      gFail("$.thought", "Expected boolean");
    if (
      part.thoughtSignature !== undefined &&
      (typeof part.thoughtSignature !== "string" || !part.thoughtSignature)
    )
      gFail("$.thoughtSignature", "Invalid original signature");
    if (part.text !== undefined && part.functionCall !== undefined)
      gFail("$.content.parts", "Native Part has multiple data types");
    this.parts.push(structuredClone(part));
    if (part.functionCall !== undefined) {
      const c = part.functionCall;
      if (!gObject(c)) gFail("$.functionCall", "Expected complete native call");
      gFields(c, ["id", "name", "args"], "$.functionCall");
      if (c.id !== undefined && (typeof c.id !== "string" || !c.id))
        gFail("$.functionCall.id", "Invalid call identity");
      const args = c.args ?? {};
      this.envelope.validateCall(c.name, args);
      const callId =
        c.id ?? `call_${this.response!.id}_${this.parts.length - 1}`;
      if (this.calls.some((x) => x.callId === callId))
        gFail("$.functionCall.id", "Duplicate call identity");
      this.calls.push({ callId, native: structuredClone(c) });
      const item = {
        id: `fc_${this.response!.id}_${this.outputs.length}`,
        type: "function_call",
        call_id: callId,
        name: c.name,
        arguments: "",
        status: "in_progress",
      };
      this.outputs.push(item);
      this.lastMessage = undefined;
      this.emitEvent("response.output_item.added", {
        ...this.ref(item),
        item: structuredClone(item),
      });
      item.arguments = JSON.stringify(args);
      this.emitEvent("response.function_call_arguments.delta", {
        ...this.ref(item),
        delta: item.arguments,
      });
    } else if (part.text !== undefined) {
      if (typeof part.text !== "string")
        gFail("$.text", "Expected native text");
      if (part.thought) {
        if (!this.summary)
          this.emitEvent("response.reasoning_summary_part.added", {
            item_id: `rs_${this.response!.id}`,
            output_index: 0,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
        this.summary += part.text;
        if (part.text)
          this.emitEvent("response.reasoning_summary_text.delta", {
            item_id: `rs_${this.response!.id}`,
            output_index: 0,
            summary_index: 0,
            delta: part.text,
          });
        return;
      }
      if (!part.text) return; // Empty signed Parts still retained above.
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
      this.lastMessage.content[0].text += part.text;
      this.emitEvent("response.output_text.delta", {
        ...this.ref(this.lastMessage),
        content_index: 0,
        delta: part.text,
      });
    } else if (!part.thoughtSignature)
      gFail("$.content.parts", "Empty or unsupported native Part");
  }
  private framesFromPending(final = false) {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((x) => x.startsWith("data:"))
        .map((x) => x.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return gFail("$.sse", "Malformed native JSON event");
      }
      this.chunk(json);
    }
    if (this.pending.length > 8 * 1024 * 1024)
      gFail("$.sse", "Native SSE frame exceeds transport bound");
    if (final && this.pending.trim())
      gFail("$.sse", "Truncated native SSE frame");
  }
  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
      this.bytes += chunk.length;
      if (this.bytes > 64 * 1024 * 1024)
        gFail("$.sse", "Native response exceeds transport bound");
      this.pending += this.decoder.decode(chunk, { stream: true });
      this.framesFromPending();
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
  _flush(callback: TransformCallback) {
    try {
      this.pending += this.decoder.decode();
      this.framesFromPending(true);
      if (!this.response || (!this.finish && !this.blocked))
        gFail("$.sse", "Native stream closed without a terminal reason");
      if (this.blocked || !["STOP", "MAX_TOKENS"].includes(this.finish!)) {
        this.emitEvent("response.failed", {
          response: {
            ...this.response,
            status: "failed",
            output: [],
            error: {
              code: `GEMINI_${this.blocked ?? this.finish}`,
              message: "Native Gemini did not complete successfully",
            },
          },
        });
        callback();
        return;
      }
      const reasonId = `rs_${this.response.id}`;
      if (
        this.envelope.outputValidator &&
        !this.calls.length &&
        this.finish === "STOP"
      ) {
        let value;
        try {
          value = JSON.parse(
            this.outputs
              .map((x) => x.content?.map((p: GObject) => p.text).join("") ?? "")
              .join(""),
          );
        } catch {
          return gFail(
            "$.output",
            "Native response violates the requested JSON output contract",
          );
        }
        if (!this.envelope.outputValidator(value))
          gFail(
            "$.output",
            "Native response violates the original output schema",
          );
      }
      if (this.summary) {
        this.emitEvent("response.reasoning_summary_text.done", {
          item_id: reasonId,
          output_index: 0,
          summary_index: 0,
          text: this.summary,
        });
        this.emitEvent("response.reasoning_summary_part.done", {
          item_id: reasonId,
          output_index: 0,
          summary_index: 0,
          part: { type: "summary_text", text: this.summary },
        });
      }
      const saved = {
        version: 1,
        content: { role: "model", parts: this.parts },
        mirrors: this.outputs.map(projection),
        calls: this.calls,
        metadata: this.frames,
      };
      const marker = {
        id: reasonId,
        type: "reasoning",
        summary: this.summary
          ? [{ type: "summary_text", text: this.summary }]
          : [],
        encrypted_content: this.envelope.history.seal(saved),
      };
      this.emitEvent("response.output_item.done", {
        output_index: 0,
        item: marker,
      });
      for (const item of this.outputs) {
        item.status = "completed";
        if (item.type === "function_call")
          this.emitEvent("response.function_call_arguments.done", {
            ...this.ref(item),
            arguments: item.arguments,
          });
        else {
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
        this.emitEvent("response.output_item.done", {
          ...this.ref(item),
          item,
        });
      }
      const u = this.usage,
        measured =
          u.promptTokenCount !== undefined &&
          u.candidatesTokenCount !== undefined &&
          u.totalTokenCount !== undefined;
      const status = this.finish === "STOP" ? "completed" : "incomplete";
      this.emitEvent(`response.${status}`, {
        response: {
          ...this.response,
          status,
          output: [marker, ...this.outputs],
          ...(status === "incomplete"
            ? { incomplete_details: { reason: "max_output_tokens" } }
            : {}),
          ...(measured
            ? {
                usage: {
                  input_tokens: u.promptTokenCount,
                  output_tokens:
                    u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0),
                  total_tokens: u.totalTokenCount,
                  ...(u.cachedContentTokenCount === undefined
                    ? {}
                    : {
                        input_tokens_details: {
                          cached_tokens: u.cachedContentTokenCount,
                        },
                      }),
                  ...(u.thoughtsTokenCount === undefined
                    ? {}
                    : {
                        output_tokens_details: {
                          reasoning_tokens: u.thoughtsTokenCount,
                        },
                      }),
                },
              }
            : {}),
        },
      });
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
}
