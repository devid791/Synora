import test from "node:test";
import assert from "node:assert/strict";
import {
  ResponsesToolCodec,
  ResponsesToolError,
  ResponsesToolStream,
} from "../src/engine/responses-tool-codec";
import { finished } from "node:stream/promises";

const grammar = {
  type: "grammar",
  syntax: "lark",
  definition: "start: /[\\s\\S]+/",
};
const catalog = () => ({
  model: "provider-fixture",
  instructions: "Unchanged instructions",
  stream: true,
  input: [
    {
      type: "additional_tools",
      id: "at-original",
      role: "developer",
      tools: [
        {
          type: "namespace",
          name: "functions",
          description: "Original namespace",
          tools: [
            {
              type: "custom",
              name: "exec",
              description: "Execute original code",
              format: grammar,
            },
            {
              type: "function",
              name: "exec_command",
              description: "Run a command",
              parameters: {
                type: "object",
                properties: {
                  cmd: { anyOf: [{ type: "string" }, { type: "null" }] },
                },
                required: ["cmd"],
                additionalProperties: false,
              },
              strict: false,
            },
          ],
        },
      ],
    },
    { role: "user", content: "Read the file" },
  ],
  session_id: "session-original",
  metadata: { turn_id: "turn-original" },
});
function setup() {
  const codec = new ResponsesToolCodec(),
    body = codec.request(catalog());
  const tools = body.tools as any[];
  return { codec, body, custom: tools[0], normal: tools[1] };
}
function begin(
  codec: ResponsesToolCodec,
  tool: any,
  id = "item-original",
  index = 0,
) {
  return codec.event({
    type: "response.output_item.added",
    output_index: index,
    item: {
      type: "function_call",
      id,
      call_id: `call-${id}`,
      name: tool.name,
      arguments: "",
      status: "in_progress",
    },
  });
}
test("Responses tools: exact original schema, namespace, input, instructions and identity retained", () => {
  const original = catalog(),
    saved = structuredClone(original),
    codec = new ResponsesToolCodec();
  const body = codec.request(original),
    tools = body.tools as any[];
  assert.deepEqual(original, saved);
  assert.equal(body.session_id, original.session_id);
  assert.deepEqual(body.metadata, original.metadata);
  assert.equal(body.instructions, original.instructions);
  assert.deepEqual(body.input, [original.input[1]]);
  assert.deepEqual(codec.catalogItems, [original.input[0]]);
  assert.equal(tools.length, 2);
  assert.match(tools[0].name, /^[a-z][a-z0-9_]{0,63}$/);
  assert.ok(tools[0].description.includes(JSON.stringify(grammar)));
  const originalTool = (original.input[0] as any).tools[0].tools[1];
  assert.deepEqual(tools[1].parameters, originalTool.parameters);
  assert.equal(tools[1].strict, false);
  assert.deepEqual(codec.counts, { advertised: 2, translated: 2, rejected: 0 });
  assert.deepEqual(
    setup().body.tools,
    body.tools,
    "wire identities are deterministic",
  );
});
test("Responses tools: historical custom/function calls and results preserve original call IDs and payloads", () => {
  const c = new ResponsesToolCodec(),
    source: any = catalog();
  source.input.push(
    {
      type: "custom_tool_call",
      namespace: "functions",
      name: "exec",
      id: "old-item",
      call_id: "old-call",
      input: "text(1);\n",
    },
    {
      type: "custom_tool_call_output",
      call_id: "old-call",
      output: [{ type: "input_text", text: "1" }],
    },
    {
      type: "function_call",
      namespace: "functions",
      name: "exec_command",
      id: "function-item",
      call_id: "function-call",
      arguments: '{ "cmd": "ls" }',
    },
  );
  const b: any = c.request(source);
  assert.deepEqual(b.input[1], {
    type: "function_call",
    id: "old-item",
    call_id: "old-call",
    name: b.tools[0].name,
    arguments: '{"input":"text(1);\\n"}',
  });
  assert.deepEqual(b.input[2], {
    type: "function_call_output",
    call_id: "old-call",
    output: [{ type: "input_text", text: "1" }],
  });
  assert.equal(b.input[3].arguments, '{ "cmd": "ls" }');
  assert.equal(b.input[3].name, b.tools[1].name);
});
test("Responses tools: explicit custom choice resolves to the same declared wire identity", () => {
  const c = new ResponsesToolCodec(),
    s: any = catalog();
  s.tool_choice = { type: "custom", namespace: "functions", name: "exec" };
  const b: any = c.request(s);
  assert.deepEqual(b.tool_choice, { type: "function", name: b.tools[0].name });
});
test("Responses streaming: one-character fragments decode escapes/surrogates incrementally, with original terminal input", () => {
  const { codec, custom } = setup();
  const start: any = begin(codec, custom);
  assert.equal(start.item.type, "custom_tool_call");
  assert.equal(start.item.namespace, "functions");
  assert.equal(start.item.name, "exec");
  const input = 'text("✓ 🧪");\n\\\t',
    raw = JSON.stringify({ input }).replace("🧪", "\\ud83e\\uddea");
  let collected = "",
    beforeClosing = false;
  for (let i = 0; i < raw.length; i++) {
    const e: any = codec.event({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "item-original",
      delta: raw[i],
    });
    if (e) {
      assert.equal(e.type, "response.custom_tool_call_input.delta");
      assert.equal(e.item_id, "item-original");
      collected += e.delta;
      beforeClosing ||= i < raw.length - 2;
    }
  }
  assert.ok(beforeClosing, "do not wait for final arguments to emit the input");
  assert.equal(collected, input);
  const done: any = codec.event({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "item-original",
    arguments: raw,
  });
  assert.equal(done.input, input);
  assert.ok(!("arguments" in done));
  const item = {
    type: "function_call",
    id: "item-original",
    call_id: "call-item-original",
    name: custom.name,
    arguments: raw,
    status: "completed",
  };
  codec.event({ type: "response.output_item.done", output_index: 0, item });
  const final: any = codec.event({
    type: "response.completed",
    response: {
      id: "response-original",
      status: "completed",
      output: [item],
      usage: { input_tokens: 11, output_tokens: 9 },
    },
  });
  assert.equal(final.response.output[0].input, input);
  assert.equal(final.response.output[0].call_id, item.call_id);
  assert.deepEqual(final.response.usage, {
    input_tokens: 11,
    output_tokens: 9,
  });
  codec.finish();
  assert.throws(
    () => codec.event({ type: "response.output_text.delta", delta: "late" }),
    /after terminal/,
  );
});
test("Responses streaming: interleaved parallel calls cannot cross arguments or identities", () => {
  const { codec, custom, normal } = setup();
  begin(codec, custom, "a", 0);
  begin(codec, custom, "b", 1);
  begin(codec, normal, "c", 2);
  const parts = ['{"input":"one"}', '{"input":"two"}'];
  for (const [index, text] of parts.entries()) {
    const e: any = codec.event({
      type: "response.function_call_arguments.delta",
      output_index: index,
      item_id: index ? "b" : "a",
      delta: text,
    });
    assert.equal(e.delta, index ? "two" : "one");
  }
  const ordinary = {
    type: "response.function_call_arguments.delta",
    output_index: 2,
    item_id: "c",
    delta: '{"cmd":',
  };
  assert.deepEqual(codec.event(ordinary), ordinary);
  assert.throws(
    () => codec.event({ ...ordinary, output_index: 0 }),
    /announced tool/,
  );
  assert.throws(() => begin(codec, normal, "a", 5), /Duplicate tool/);
});
test("Responses streaming: malformed/changed/extra/duplicate arguments fail instead of producing terminal success", () => {
  for (const raw of [
    '{"input":"ok","extra":1}',
    '{"input":"a","input":"b"}',
    '{"input":123}',
    '{"input":"\\q"}',
    '{"input":"unterminated',
  ]) {
    const { codec, custom } = setup();
    begin(codec, custom);
    assert.throws(() => {
      codec.event({
        type: "response.function_call_arguments.delta",
        item_id: "item-original",
        output_index: 0,
        delta: raw,
      });
      codec.event({
        type: "response.function_call_arguments.done",
        item_id: "item-original",
        output_index: 0,
        arguments: raw,
      });
    }, ResponsesToolError);
    assert.throws(() => codec.finish(), /without a terminal/);
  }
  const { codec, custom } = setup();
  begin(codec, custom);
  codec.event({
    type: "response.function_call_arguments.delta",
    item_id: "item-original",
    output_index: 0,
    delta: '{"input":"a"}',
  });
  assert.throws(
    () =>
      codec.event({
        type: "response.function_call_arguments.done",
        item_id: "item-original",
        output_index: 0,
        arguments: '{"input":"b"}',
      }),
    /differ/,
  );
});
test("Responses errors: unknown tools, unsupported catalogs and limits are explicit; never silently truncate", () => {
  for (const bad of [
    { type: "web_search" },
    { type: "tool_search" },
    { type: "function", name: "later", parameters: {}, defer_loading: true },
  ]) {
    assert.throws(
      () => new ResponsesToolCodec().request({ tools: [bad] }),
      (e: any) =>
        e.code === "PROVIDER_TOOL_COMPATIBILITY" &&
        e.path.startsWith("$.tools[0]"),
    );
  }
  assert.throws(
    () =>
      new ResponsesToolCodec().request({
        tools: Array.from({ length: 129 }, (_, i) => ({
          type: "function",
          name: `tool_${i}`,
          parameters: {},
        })),
      }),
    /not truncated/,
  );
  const { codec } = setup();
  assert.throws(
    () => begin(codec, { name: "not_advertised" }),
    /not advertised/,
  );
  assert.throws(() => codec.finish(), /without a terminal/);
});
test("Responses errors: ordinary text and real failure retained, incomplete stream is not successful", () => {
  const { codec } = setup();
  const delta = {
    type: "response.output_text.delta",
    item_id: "message",
    delta: "literal <script>not markup</script>",
  };
  assert.deepEqual(codec.event(delta), delta);
  const failure = {
    type: "response.failed",
    response: {
      id: "r",
      status: "failed",
      error: { code: "upstream_error", message: "Original failure" },
      output: [],
    },
  };
  assert.deepEqual(codec.event(failure), failure);
  codec.finish();
});

test("Responses stream: SSE byte fragmentation, CRLF, original event IDs, comments, retry and progressive text", async () => {
  const { codec } = setup(),
    stream = new ResponsesToolStream(codec);
  let received = "";
  stream.on("data", (v) => {
    received += v.toString();
  });
  const done = finished(stream);
  const initial = Buffer.from(
    ': keepalive\r\n\r\nid: event-original\r\nretry: 1000\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"hello 🧪"}\r\n\r\n',
  );
  for (const byte of initial) stream.write(Buffer.from([byte]));
  assert.ok(
    received.includes("hello 🧪"),
    "text must be emitted before stream completion",
  );
  assert.ok(received.includes("id: event-original"));
  assert.ok(received.includes("retry: 1000"));
  assert.ok(received.includes(": keepalive"));
  stream.end(
    'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
  );
  await done;
  assert.ok(received.includes("response.completed"));
  assert.ok(received.endsWith("data: [DONE]\n\n"));
});
test("Responses stream: malformed JSON, invalid UTF8, premature DONE and truncated frames do not pass", async () => {
  for (const raw of [
    Buffer.from("data: [DONE]\n\n"),
    Buffer.from("data: {}\n\n"),
    Buffer.from("data: {"),
    Buffer.from([0xff]),
    Buffer.from(
      'event: wrong\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
    ),
  ]) {
    const { codec } = setup(),
      stream = new ResponsesToolStream(codec);
    stream.resume();
    const outcome = finished(stream);
    stream.end(raw);
    await assert.rejects(outcome);
  }
});
test("Responses stream: final response and call identity changes cannot produce completion", () => {
  const { codec, custom } = setup();
  codec.event({ type: "response.created", response: { id: "first" } });
  assert.throws(
    () =>
      codec.event({
        type: "response.completed",
        response: { id: "second", status: "completed", output: [] },
      }),
    /identity changed/,
  );
  begin(codec, custom);
  assert.throws(
    () =>
      codec.event({
        type: "response.completed",
        response: { id: "first", status: "completed", output: [] },
      }),
    /omitted/,
  );
  assert.throws(
    () =>
      codec.event({
        type: "response.completed",
        response: { id: "first", status: "failed", output: [] },
      }),
    /Completion requires/,
  );
});
test("Responses stream: real failure with partial custom input keeps its error without synthetic completion", () => {
  const { codec, custom } = setup();
  begin(codec, custom);
  codec.event({
    type: "response.function_call_arguments.delta",
    item_id: "item-original",
    output_index: 0,
    delta: '{"input":"partial',
  });
  const e: any = codec.event({
    type: "response.failed",
    response: {
      id: "r",
      status: "failed",
      error: { code: "timeout", message: "Original deadline" },
      output: [
        {
          type: "function_call",
          name: custom.name,
          id: "item-original",
          call_id: "call-item-original",
          arguments: '{"input":"partial',
        },
      ],
    },
  });
  assert.equal(e.response.error.message, "Original deadline");
  assert.equal(e.response.output[0].input, "partial");
  codec.finish();
});

test("Responses tools: qualified namespace identity and whitespace cannot change argument meaning", () => {
  const source: any = catalog();
  source.input[0].tools[0].tools[0].namespace = "wrong";
  assert.throws(
    () => new ResponsesToolCodec().request(source),
    /enclosing namespace/,
  );
  const { codec, custom } = setup();
  begin(codec, custom);
  const prefix = " ".repeat(300);
  assert.equal(
    codec.event({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "item-original",
      delta: prefix,
    }),
    null,
  );
  const raw = `${prefix}{"input":"test"}`;
  const delta: any = codec.event({
    type: "response.function_call_arguments.delta",
    output_index: 0,
    item_id: "item-original",
    delta: '{"input":"test"}',
  });
  assert.equal(delta.delta, "test");
  const done: any = codec.event({
    type: "response.function_call_arguments.done",
    output_index: 0,
    item_id: "item-original",
    arguments: raw,
  });
  assert.equal(done.input, "test");
});

test("Responses custom input: escaped property name is semantically input, even across byte-sized events", () => {
  const { codec, custom } = setup();
  begin(codec, custom);
  const raw = '{"\\u0069nput":"correct"}';
  let input = "";
  for (const char of raw) {
    const event: any = codec.event({
      type: "response.function_call_arguments.delta",
      item_id: "item-original",
      output_index: 0,
      delta: char,
    });
    if (event) input += event.delta;
  }
  assert.equal(input, "correct");
  const done: any = codec.event({
    type: "response.function_call_arguments.done",
    item_id: "item-original",
    output_index: 0,
    arguments: raw,
  });
  assert.equal(done.input, "correct");
});
