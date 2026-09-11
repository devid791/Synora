import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

type ObjectValue = Record<string, unknown>;
type Identity = { name: string; namespace?: string; custom: boolean };
type Tool = Identity & { wire: string; definition?: ObjectValue };
const object = (v: unknown): v is ObjectValue =>
  !!v && typeof v === "object" && !Array.isArray(v);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A provider-boundary error, never an instruction to drop a catalog entry. */
export class ResponsesToolError extends Error {
  readonly code = "PROVIDER_TOOL_COMPATIBILITY";
  constructor(
    readonly path: string,
    readonly tool: string | null,
    readonly reason: string,
  ) {
    super(`${path}${tool ? ` (${tool})` : ""}: ${reason}`);
  }
}
function fail(path: string, reason: string, tool: string | null = null): never {
  throw new ResponsesToolError(path, tool, reason);
}
function identity(v: ObjectValue, path: string, namespace?: string): Identity {
  if (typeof v.name !== "string" || !v.name || v.name.length > 1024)
    fail(`${path}.name`, "Expected a nonempty bounded tool name");
  const ns = namespace ?? v.namespace;
  if (
    namespace !== undefined &&
    v.namespace !== undefined &&
    v.namespace !== namespace
  )
    fail(
      `${path}.namespace`,
      "Declaration disagrees with its enclosing namespace",
      v.name,
    );
  if (ns !== undefined && (typeof ns !== "string" || !ns || ns.length > 1024))
    fail(`${path}.namespace`, "Invalid original namespace", v.name);
  return {
    name: v.name,
    ...(typeof ns === "string" ? { namespace: ns } : {}),
    custom: v.type === "custom" || v.type === "custom_tool_call",
  };
}
function originalName(t: Identity) {
  return t.namespace ? `${t.namespace}.${t.name}` : t.name;
}
function identityKey(t: Identity) {
  return JSON.stringify([t.namespace ?? null, t.name, t.custom]);
}

/** Incremental JSON-string decoder for the exact {"input": string} wrapper.
 * Does not evaluate code or grammar, and never emits raw/partially escaped JSON.
 */
class CustomArguments {
  raw = "";
  text = "";
  private offset = 0;
  private started = false;
  private ended = false;
  private heldSurrogate = "";
  private prefix: "open" | "key" | "key-string" | "colon" | "value" = "open";
  private keyStart = 0;
  private keyEscape = false;
  constructor(
    private path: string,
    private tool: string,
  ) {}
  append(delta: string): string {
    if (this.raw.length + delta.length > 4 * 1024 * 1024)
      fail(this.path, "Tool arguments exceed the transport bound", this.tool);
    this.raw += delta;
    // Scan the prefix only once, including escaped JSON property spelling.
    // Re-running a whole-prefix regexp per tiny SSE delta is quadratic.
    while (!this.started && this.offset < this.raw.length) {
      const char = this.raw[this.offset++];
      if (this.prefix === "key-string") {
        if (this.keyEscape) {
          this.keyEscape = false;
          continue;
        }
        if (char === "\\") {
          this.keyEscape = true;
          continue;
        }
        if (char === '"') {
          let key: unknown;
          try {
            key = JSON.parse(this.raw.slice(this.keyStart, this.offset));
          } catch {
            fail(this.path, "Invalid JSON property name", this.tool);
          }
          if (key !== "input")
            fail(
              this.path,
              "Expected the original input string property",
              this.tool,
            );
          this.prefix = "colon";
        }
        continue;
      }
      if (/[ \t\r\n]/.test(char)) continue;
      if (this.prefix === "open" && char === "{") this.prefix = "key";
      else if (this.prefix === "key" && char === '"') {
        this.keyStart = this.offset - 1;
        this.prefix = "key-string";
      } else if (this.prefix === "colon" && char === ":") this.prefix = "value";
      else if (this.prefix === "value" && char === '"') this.started = true;
      else fail(this.path, "Expected a single input string wrapper", this.tool);
    }
    if (!this.started) return "";
    let decoded = "";
    while (!this.ended && this.offset < this.raw.length) {
      const char = this.raw[this.offset];
      if (char === '"') {
        this.offset++;
        this.ended = true;
        break;
      }
      if (char === "\\") {
        if (this.offset + 1 >= this.raw.length) break;
        const escape = this.raw[this.offset + 1];
        const count = escape === "u" ? 6 : 2;
        if (this.offset + count > this.raw.length) break;
        try {
          decoded += JSON.parse(
            `"${this.raw.slice(this.offset, this.offset + count)}"`,
          );
        } catch {
          fail(this.path, "Invalid JSON string escape", this.tool);
        }
        this.offset += count;
      } else {
        if (char.charCodeAt(0) < 32)
          fail(
            this.path,
            "Unescaped control character in arguments",
            this.tool,
          );
        decoded += char;
        this.offset++;
      }
    }
    decoded = this.heldSurrogate + decoded;
    this.heldSurrogate = "";
    if (decoded && /[\uD800-\uDBFF]/.test(decoded.at(-1)!)) {
      this.heldSurrogate = decoded.at(-1)!;
      decoded = decoded.slice(0, -1);
    }
    this.text += decoded;
    return decoded;
  }
  finish(value: string): string {
    if (this.raw && this.raw !== value)
      fail(
        this.path,
        "Final arguments differ from the streamed arguments",
        this.tool,
      );
    if (!this.raw) this.append(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      fail(this.path, "Malformed final tool arguments", this.tool);
    }
    if (
      !object(parsed) ||
      Object.keys(parsed).length !== 1 ||
      typeof parsed.input !== "string"
    )
      fail(
        this.path,
        "Custom tool requires exactly one input string",
        this.tool,
      );
    // Reject duplicate input keys as well as trailing data. The streaming
    // decoder must have consumed the one string and only a closing object.
    if (!this.ended || !/^\s*}\s*$/.test(this.raw.slice(this.offset)))
      fail(
        this.path,
        "Unexpected custom argument properties or trailing data",
        this.tool,
      );
    this.text += this.heldSurrogate;
    this.heldSurrogate = "";
    if (this.text !== parsed.input)
      fail(this.path, "Decoded tool input differs from final input", this.tool);
    return parsed.input;
  }
}

/** Reversible Core Responses -> JSON function-tool boundary. This owns no
 * network, credentials, executable or tool. The original Core remains executor.
 * One instance per request/response stream; catalog entries are never dropped.
 */
export class ResponsesToolCodec {
  constructor(
    private readonly catalogPolicy: {
      maxTools: number | null;
      provider: string;
    } = { maxTools: 128, provider: "xAI" },
  ) {}
  private byIdentity = new Map<string, Tool>();
  private byWire = new Map<string, Tool>();
  private calls = new Map<
    string,
    { tool: Tool; callId: string; index: number; decoder?: CustomArguments }
  >();
  private terminal = false;
  private requested = false;
  private responseId?: string;
  private toolCount = 0;
  private originalCatalogItems: ObjectValue[] = [];
  /** Original metadata-only catalog markers stay host-side, including their IDs.
   * xAI has no additional_tools input item. No call/item/result identity is rewritten.
   */
  get catalogItems() {
    return structuredClone(this.originalCatalogItems);
  }
  get counts() {
    const tools = [...this.byIdentity.values()].filter((t) => t.definition);
    return {
      advertised: tools.length,
      translated: tools.filter(
        (t) => t.custom || t.wire !== t.name || t.namespace,
      ).length,
      rejected: 0,
    };
  }
  private register(id: Identity): Tool {
    const key = identityKey(id),
      prior = this.byIdentity.get(key);
    if (prior) return prior;
    // Encode every tool so plain names cannot collide with namespaced aliases.
    const wire = `synora_${createHash("sha256").update(key).digest("hex").slice(0, 56)}`;
    const collision = this.byWire.get(wire);
    if (collision) fail("$.tools", "Wire identity collision", originalName(id));
    const tool = { ...id, wire };
    this.byIdentity.set(key, tool);
    this.byWire.set(wire, tool);
    return tool;
  }
  private tools(
    values: unknown,
    path: string,
    namespace?: string,
    description?: string,
  ): ObjectValue[] {
    if (!Array.isArray(values)) fail(path, "Expected a tool array");
    const result: ObjectValue[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i],
        p = `${path}[${i}]`;
      if (!object(v)) fail(p, "Expected a tool object");
      if (v.type === "namespace") {
        if (namespace) fail(p, "Nested tool namespaces are unsupported");
        const id = identity(v, p);
        for (const k of Object.keys(v))
          if (!["type", "name", "description", "tools"].includes(k))
            fail(`${p}.${k}`, "Unsupported namespace property", id.name);
        if (v.description !== undefined && typeof v.description !== "string")
          fail(`${p}.description`, "Expected text", id.name);
        result.push(
          ...this.tools(
            v.tools,
            `${p}.tools`,
            id.name,
            v.description as string | undefined,
          ),
        );
        continue;
      }
      if (v.type !== "function" && v.type !== "custom")
        fail(
          `${p}.type`,
          `No semantics-preserving mapping for tool type ${String(v.type)}`,
          typeof v.name === "string" ? v.name : null,
        );
      const t = this.register(identity(v, p, namespace));
      const allowed = t.custom
        ? [
            "type",
            "name",
            "description",
            "format",
            "namespace",
            "defer_loading",
          ]
        : [
            "type",
            "name",
            "description",
            "parameters",
            "strict",
            "namespace",
            "defer_loading",
          ];
      for (const k of Object.keys(v))
        if (!allowed.includes(k))
          fail(`${p}.${k}`, "Unsupported tool property", originalName(t));
      if (v.defer_loading !== undefined && v.defer_loading !== false)
        fail(
          `${p}.defer_loading`,
          "Deferred availability requires a provider tool-search adapter",
          originalName(t),
        );
      if (v.description !== undefined && typeof v.description !== "string")
        fail(`${p}.description`, "Expected text", originalName(t));
      if (!t.custom && !object(v.parameters))
        fail(
          `${p}.parameters`,
          "Expected the original JSON schema",
          originalName(t),
        );
      if (v.strict !== undefined && typeof v.strict !== "boolean")
        fail(`${p}.strict`, "Expected a boolean", originalName(t));
      const signature = structuredClone(v);
      if (t.definition && !equal(t.definition, signature))
        fail(
          p,
          "Conflicting declarations for the same original tool identity",
          originalName(t),
        );
      if (t.definition) continue;
      t.definition = signature;
      if (++this.toolCount > (this.catalogPolicy.maxTools ?? Infinity))
        fail(
          path,
          `${this.catalogPolicy.provider} documents a maximum of ${this.catalogPolicy.maxTools} function tools; catalog was not truncated`,
        );
      const details = [
        `Original Core tool: ${originalName(t)}`,
        description,
        v.description,
      ]
        .filter(Boolean)
        .join("\n\n");
      result.push({
        type: "function",
        name: t.wire,
        ...(details ? { description: details } : {}),
        ...(t.custom
          ? {
              description: `${details}${details ? "\n\n" : ""}Pass the complete original tool input as the input string.${v.format === undefined ? "" : `\nOriginal input format (unchanged): ${JSON.stringify(v.format)}`}`,
              parameters: {
                type: "object",
                properties: { input: { type: "string" } },
                required: ["input"],
                additionalProperties: false,
              },
              strict: true,
            }
          : {
              parameters: structuredClone(v.parameters),
              ...(v.strict !== undefined ? { strict: v.strict } : {}),
            }),
      });
    }
    return result;
  }
  private input(v: unknown, path: string): unknown {
    if (!object(v)) fail(path, "Expected an original Responses input item");
    if (v.type === "function_call" || v.type === "custom_tool_call") {
      const t = this.register(identity(v, path));
      const { namespace: _namespace, input, ...rest } = v;
      if (t.custom && typeof input !== "string")
        fail(
          `${path}.input`,
          "Expected original custom input",
          originalName(t),
        );
      return {
        ...rest,
        type: "function_call",
        name: t.wire,
        ...(t.custom ? { arguments: JSON.stringify({ input }) } : {}),
      };
    }
    if (v.type === "custom_tool_call_output")
      return { ...v, type: "function_call_output" };
    return v;
  }
  request(source: ObjectValue): ObjectValue {
    if (this.requested) fail("$", "A codec instance handles only one request");
    this.requested = true;
    const body = structuredClone(source);
    const tools =
      body.tools === undefined ? [] : this.tools(body.tools, "$.tools");
    if (Array.isArray(body.input)) {
      body.input = body.input.flatMap((item: unknown, i: number) => {
        const path = `$.input[${i}]`;
        if (object(item) && item.type === "additional_tools") {
          for (const k of Object.keys(item))
            if (!["type", "tools", "id", "role"].includes(k))
              fail(
                `${path}.${k}`,
                "Unsupported additional tool catalog property",
              );
          if (
            item.id !== undefined &&
            item.id !== null &&
            typeof item.id !== "string"
          )
            fail(`${path}.id`, "Expected original catalog marker ID");
          if (item.role !== undefined && item.role !== "developer")
            fail(
              `${path}.role`,
              "Only Core's developer tool declaration is supported",
            );
          this.originalCatalogItems.push(structuredClone(item));
          tools.push(...this.tools(item.tools, `${path}.tools`));
          return [];
        }
        return [this.input(item, path)];
      });
    }
    body.tools = tools;
    if (object(body.tool_choice)) {
      const choice = body.tool_choice;
      if (choice.type !== "function" && choice.type !== "custom")
        fail("$.tool_choice", "Unsupported structured tool choice");
      const key = identityKey(identity(choice, "$.tool_choice")),
        t = this.byIdentity.get(key);
      if (!t?.definition)
        fail(
          "$.tool_choice.name",
          "Selected tool is not declared in this request",
        );
      const { namespace: _ns, ...rest } = choice;
      body.tool_choice = { ...rest, type: "function", name: t.wire };
    }
    return body;
  }
  private output(
    v: unknown,
    path: string,
    opening = false,
    partial = false,
  ): ObjectValue {
    if (!object(v)) fail(path, "Expected a response output item");
    if (v.type !== "function_call") return v;
    const t = typeof v.name === "string" ? this.byWire.get(v.name) : undefined;
    if (!t?.definition)
      fail(
        `${path}.name`,
        "Response called a tool not advertised in this request",
        typeof v.name === "string" ? v.name : null,
      );
    if (
      typeof v.id !== "string" ||
      !v.id ||
      typeof v.call_id !== "string" ||
      !v.call_id
    )
      fail(
        path,
        "A tool call must preserve its nonempty item and call IDs",
        originalName(t),
      );
    const announced = this.calls.get(v.id);
    if (
      !opening &&
      (!announced || announced.callId !== v.call_id || announced.tool !== t)
    )
      fail(
        path,
        "Output tool identity differs from the announced call",
        originalName(t),
      );
    const { arguments: args, ...rest } = v;
    if (typeof args !== "string")
      fail(`${path}.arguments`, "Expected argument string", originalName(t));
    const original = {
      ...rest,
      name: t.name,
      ...(t.namespace ? { namespace: t.namespace } : {}),
    };
    if (!t.custom) return { ...original, arguments: args };
    if (partial)
      return {
        ...original,
        type: "custom_tool_call",
        input: announced?.decoder?.text ?? "",
      };
    if (opening && args === "")
      return { ...original, type: "custom_tool_call", input: "" };
    const decoder =
      this.calls.get(v.id)?.decoder ??
      new CustomArguments(`${path}.arguments`, originalName(t));
    return {
      ...original,
      type: "custom_tool_call",
      input: decoder.finish(args),
    };
  }
  /** One original provider event in, zero or one Core events out. Text events
   * and ordinary function deltas remain incremental and unmodified.
   */
  event(source: ObjectValue): ObjectValue | null {
    if (this.terminal) fail("$.type", "Event received after terminal response");
    const event = structuredClone(source),
      type = event.type;
    if (object(event.response) && typeof event.response.id === "string") {
      if (this.responseId && this.responseId !== event.response.id)
        fail("$.response.id", "Response identity changed within the stream");
      this.responseId = event.response.id;
    }
    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done"
    ) {
      const item = event.item;
      if (object(item) && item.type === "function_call") {
        const original = this.output(item, "$.item", type.endsWith(".added"));
        if (
          !Number.isSafeInteger(event.output_index) ||
          (event.output_index as number) < 0
        )
          fail("$.output_index", "Expected a nonnegative output index");
        if (type.endsWith(".added")) {
          if (
            this.calls.has(item.id as string) ||
            [...this.calls.values()].some(
              (c) =>
                c.callId === item.call_id || c.index === event.output_index,
            )
          )
            fail("$.item.id", "Duplicate tool item, call or output index");
          const tool = this.byWire.get(item.name as string)!;
          const decoder = tool.custom
            ? new CustomArguments("$.delta", originalName(tool))
            : undefined;
          if (decoder && item.arguments)
            decoder.append(item.arguments as string);
          this.calls.set(item.id as string, {
            tool,
            callId: item.call_id as string,
            index: event.output_index as number,
            decoder,
          });
        } else {
          const call = this.calls.get(item.id as string);
          if (
            !call ||
            call.callId !== item.call_id ||
            call.index !== event.output_index ||
            call.tool.wire !== item.name
          )
            fail(
              "$.item",
              "Completed tool identity differs from the announced call",
            );
        }
        event.item = original;
      }
    } else if (
      type === "response.function_call_arguments.delta" ||
      type === "response.function_call_arguments.done"
    ) {
      const call = this.calls.get(event.item_id as string);
      if (!call || call.index !== event.output_index)
        fail("$.item_id", "Arguments do not belong to an announced tool call");
      const argumentField = type.endsWith(".delta") ? "delta" : "arguments";
      if (typeof event[argumentField] !== "string")
        fail(`$.${argumentField}`, "Expected argument string");
      if (call.decoder) {
        if (type.endsWith(".delta")) {
          if (typeof event.delta !== "string")
            fail("$.delta", "Expected argument delta");
          const delta = call.decoder.append(event.delta);
          if (!delta) return null;
          return {
            ...event,
            type: "response.custom_tool_call_input.delta",
            delta,
          };
        }
        if (typeof event.arguments !== "string")
          fail("$.arguments", "Expected final arguments");
        const { arguments: args, ...rest } = event;
        return {
          ...rest,
          type: "response.custom_tool_call_input.done",
          input: call.decoder.finish(args as string),
        };
      }
    }
    if (
      ["response.completed", "response.failed", "response.incomplete"].includes(
        type as string,
      )
    ) {
      const response = event.response;
      if (!object(response))
        fail("$.response", "Terminal event has no response object");
      if (type === "response.completed") {
        if (response.status !== "completed" || !Array.isArray(response.output))
          fail(
            "$.response",
            "Completion requires completed status and final output",
          );
        for (const id of this.calls.keys())
          if (
            !response.output.some(
              (v) => object(v) && v.id === id && v.type === "function_call",
            )
          )
            fail(
              "$.response.output",
              "Completed response omitted an announced tool call",
            );
      }
      if (Array.isArray(response.output))
        response.output = response.output.map((v, i) =>
          this.output(
            v,
            `$.response.output[${i}]`,
            false,
            type !== "response.completed",
          ),
        );
      this.terminal = true;
    }
    return event;
  }
  finish() {
    if (!this.terminal)
      fail("$", "Provider stream ended without a terminal response");
  }
}

/** SSE framing is incremental and bounded, with normal Transform backpressure.
 * Only tool encoding changes. Preserve event IDs/retry/comment fields; never
 * turn a truncated socket, malformed event or provider failure into completion.
 */
export class ResponsesToolStream extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  constructor(private codec: ResponsesToolCodec) {
    super();
  }
  private frames(final = false) {
    if (this.pending.length > 8 * 1024 * 1024)
      fail("$.sse", "SSE frame exceeds transport bound");
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(this.pending);
      if (!boundary) break;
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      const lines = frame.split(/\r?\n/);
      const data: string[] = [],
        metadata: string[] = [];
      let declared: string | undefined;
      for (const line of lines) {
        const i = line.indexOf(":"),
          key = i < 0 ? line : line.slice(0, i);
        const value = (i < 0 ? "" : line.slice(i + 1)).replace(/^ /, "");
        if (key === "data") data.push(value);
        else if (key === "event") declared = value;
        else metadata.push(line);
      }
      if (!data.length) {
        this.push(`${frame}\n\n`);
        continue;
      }
      const text = data.join("\n");
      if (text === "[DONE]") {
        this.codec.finish();
        this.push(`${frame}\n\n`);
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        fail("$.sse.data", "Malformed event JSON");
      }
      if (!object(value) || typeof value.type !== "string")
        fail("$.sse.data", "Expected a typed Responses event");
      if (declared && declared !== value.type)
        fail("$.sse.event", "SSE event and JSON type disagree");
      const event = this.codec.event(value);
      if (event)
        this.push(
          `${[...metadata, `event: ${event.type}`, `data: ${JSON.stringify(event)}`].join("\n")}\n\n`,
        );
    }
    if (final && this.pending.trim())
      fail("$.sse", "Unterminated final SSE frame");
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ) {
    try {
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
      this.codec.finish();
      callback();
    } catch (e) {
      callback(e as Error);
    }
  }
}
