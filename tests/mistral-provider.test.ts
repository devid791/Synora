import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NativeHistory } from "../src/engine/native-history";
import { MistralEnvelope } from "../src/engine/mistral-envelope";
import { MistralStream } from "../src/engine/mistral-stream";
import {
  mistralBridge,
  mistralEndpoint,
  mistralModels,
  validateMistralSelection,
} from "../src/engine/mistral-provider";
import { ResponsesToolStream } from "../src/engine/responses-tool-codec";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import {
  mistralCapabilities as model,
  mistralFixtureModel,
  mistralFrames,
  mistralSse,
  mistralToolDeltas,
} from "./fixtures/mistral-wire";

const history = () =>
  new NativeHistory(
    Buffer.alloc(32, 9),
    "controlled-mistral-domain",
    "mistral",
  );
const request = (): any => ({
  model: model.id,
  store: false,
  stream: true,
  instructions: "Original Core system",
  input: [
    {
      type: "message",
      role: "developer",
      content: "Original workspace instructions",
    },
    { role: "user", content: "Read a file" },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      description: "Original namespace",
      tools: [
        {
          type: "custom",
          name: "exec",
          description: "Original executor",
          format: { type: "text" },
        },
      ],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
  include: ["reasoning.encrypted_content"],
  client_metadata: { session_id: "original-session" },
  prompt_cache_key: "original-cache",
});
function envelope(source = request(), h = history()) {
  const e = new MistralEnvelope(model, h);
  const wire = JSON.parse(
    e.request(Buffer.from(JSON.stringify(source))).toString(),
  );
  return { e, source, wire };
}
const events = (output: string) =>
  output
    .split("\n\n")
    .filter((x) => x.includes("data:"))
    .map((x) =>
      JSON.parse(
        x
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(5),
      ),
    );
async function convert(
  frames: any[] | Buffer,
  e: MistralEnvelope,
  done = true,
  nativeEvents?: any[],
) {
  const bytes = Buffer.isBuffer(frames) ? frames : mistralSse(frames, done),
    chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 7)
    chunks.push(bytes.subarray(i, i + 7));
  let output = "",
    native = "";
  const stream = new MistralStream(e);
  if (nativeEvents)
    stream.on("data", (chunk) => {
      native += chunk;
    });
  await pipeline(
    Readable.from(chunks),
    stream,
    new ResponsesToolStream(e.tools),
    async (source) => {
      for await (const c of source) output += c;
    },
  );
  if (nativeEvents) nativeEvents.push(...events(native));
  return events(output);
}
async function listen(s: Server) {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as any).port}/v1`;
}
async function close(s: Server) {
  s.closeAllConnections();
  await new Promise<void>((r) => s.close(() => r()));
}

test("Mistral endpoints and authenticated catalog preserve real limits, modalities and only documented efforts", async (t) => {
  assert.equal(
    mistralEndpoint("https://api.mistral.ai/v1/"),
    "https://api.mistral.ai/v1",
  );
  for (const url of [
    "http://api.mistral.ai/v1",
    "https://other.invalid/v1",
    "https://api.mistral.ai:444/v1",
    "https://user:key@api.mistral.ai/v1",
    "https://api.mistral.ai/v1?key=secret",
    "https://api.mistral.ai/v1#x",
    "http://192.168.0.2/v1",
    "http://localhost/wrong",
  ])
    assert.throws(() => mistralEndpoint(url));
  let body: any = {
    data: [
      mistralFixtureModel,
      { ...mistralFixtureModel, id: "unknown-model", aliases: [] },
      {
        ...mistralFixtureModel,
        id: "embedding",
        capabilities: { completion_chat: false, function_calling: false },
      },
      {
        ...mistralFixtureModel,
        id: "missing-context",
        max_context_length: undefined,
      },
      { ...mistralFixtureModel, id: "archived", archived: true },
      {
        ...mistralFixtureModel,
        id: "no-tools",
        capabilities: { completion_chat: true, function_calling: false },
      },
    ],
  };
  const s = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer controlled-key");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  const url = await listen(s);
  t.after(() => close(s));
  const list = await mistralModels(url, "controlled-key");
  assert.equal(list.length, 6);
  assert.equal(list[0].context_window, 262144);
  assert.deepEqual(list[0].reasoning_efforts, ["none", "high"]);
  assert.deepEqual(list[1].reasoning_efforts, []);
  assert.equal(list[0].providerModel!.provider, "mistral");
  assert.deepEqual(list[0].providerModel!.inputModalities, ["text", "image"]);
  assert.equal(validateMistralSelection(list, model.id, "high"), list[0]);
  assert.equal(list[5].providerModel!.mistral!.functionCalling, false);
  assert.equal(
    list[5].unavailableReason,
    "Model does not support function calling required by Core",
  );
  assert.throws(
    () => validateMistralSelection(list, "no-tools"),
    /function calling required by Core/,
  );
  for (const [id, effort] of [
    [model.id, "medium"],
    ["unknown-model", "high"],
    ["embedding", undefined],
    ["missing-context", undefined],
    ["archived", undefined],
    ["absent", undefined],
  ])
    assert.throws(() => validateMistralSelection(list, id!, effort));
  await assert.rejects(mistralModels(url), /key/);
  body = { data: [mistralFixtureModel, mistralFixtureModel] };
  await assert.rejects(mistralModels(url, "controlled-key"), /Duplicate/);
  body = { data: [{ ...mistralFixtureModel, max_context_length: -1 }] };
  await assert.rejects(mistralModels(url, "controlled-key"));
});

test("Mistral catalogs refuse redirects without forwarding the API key", async (t) => {
  let redirected = 0;
  const target = createServer((_req, res) => {
    redirected++;
    res.end("{}");
  });
  const targetUrl = await listen(target);
  t.after(() => close(target));
  const s = createServer((_req, res) => {
    res.writeHead(302, { location: `${targetUrl}/models` });
    res.end();
  });
  const url = await listen(s);
  t.after(() => close(s));
  await assert.rejects(mistralModels(url, "controlled-key"));
  assert.equal(redirected, 0);
});

test("Mistral native envelope retains full instructions, interleaved history, schemas and private metadata", () => {
  const source = request();
  source.input.push(
    { role: "assistant", content: "Earlier answer" },
    { role: "developer", content: "Later instructions stay later" },
    {
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: "data:image/png;base64,AAAA",
          detail: "auto",
        },
      ],
    },
  );
  source.max_output_tokens = 2048;
  const { wire, e } = envelope(source);
  assert.deepEqual(wire.messages.slice(0, 5), [
    { role: "system", content: "Original Core system" },
    { role: "system", content: "Original workspace instructions" },
    { role: "user", content: "Read a file" },
    { role: "assistant", content: "Earlier answer" },
    { role: "system", content: "Later instructions stay later" },
  ]);
  assert.deepEqual(wire.messages[5].content, [
    { type: "image_url", image_url: "data:image/png;base64,AAAA" },
  ]);
  assert.equal(wire.reasoning_effort, "high");
  assert.equal(wire.max_tokens, 2048);
  assert.equal(wire.n, 1);
  assert.equal(wire.stream_options.include_usage, true);
  assert.equal(wire.tools[0].function.strict, true);
  assert.match(wire.tools[0].function.description, /Original namespace/);
  assert.equal(e.tools.counts.advertised, 1);
  assert.ok(e.metadata.some((x) => x.path === "$.input"));
  assert.equal(wire.client_metadata, undefined);
  assert.equal(wire.prompt_cache_key, undefined);
});

test("Mistral signed ThinkChunk transition, fragmented custom calls, full lifecycle and cold round-trip", async (t) => {
  const dir = await mkdtemp(join(process.cwd(), ".mistral-history-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const histories = await Promise.all(
    Array.from({ length: 4 }, () =>
      NativeHistory.load(dir, "https://api.mistral.ai/v1", model.id, "mistral"),
    ),
  );
  const { e, source, wire } = envelope(request(), histories[0]);
  const name = wire.tools[0].function.name;
  const nativeEvents: any[] = [];
  const result = await convert(
    mistralFrames("native-response", mistralToolDeltas(name), "tool_calls"),
    e,
    true,
    nativeEvents,
  );
  assert.equal(result[0].type, "response.created");
  assert.equal(result.at(-1).type, "response.completed");
  assert.deepEqual(
    nativeEvents.map((x) => x.sequence_number),
    nativeEvents.map((_, i) => i),
  );
  // The shared custom codec drops just the structural JSON prefix, which has
  // no input characters. All other event identities/order are unchanged.
  const structural = nativeEvents.find(
    (x) =>
      x.type === "response.function_call_arguments.delta" &&
      x.delta === '{"input"',
  );
  assert.ok(structural);
  assert.deepEqual(
    result.map((x) => x.sequence_number),
    nativeEvents.filter((x) => x !== structural).map((x) => x.sequence_number),
  );
  for (const type of [
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.custom_tool_call_input.delta",
    "response.custom_tool_call_input.done",
    "response.output_item.done",
  ])
    assert.ok(
      result.some((x) => x.type === type),
      type,
    );
  const final = result.at(-1).response;
  assert.equal(final.id, "native-response");
  assert.deepEqual(final.usage, {
    input_tokens: 100,
    output_tokens: 30,
    total_tokens: 130,
  });
  const call = final.output.find((x: any) => x.type === "custom_tool_call");
  assert.equal(call.call_id, "aB1234567");
  assert.equal(call.name, "exec");
  assert.equal(call.namespace, "functions");
  assert.equal(call.input, "text(42)");
  const saved = histories[1].restore(final.output[0].encrypted_content) as any;
  assert.deepEqual(saved.message.content[0], {
    type: "thinking",
    thinking: [
      { type: "text", text: "Reason €" },
      { type: "text", text: " first" },
    ],
    signature: "controlled-original-signature",
    closed: true,
  });
  assert.equal(saved.message.tool_calls[0].id, call.call_id);
  source.input.push(...final.output, {
    type: "custom_tool_call_output",
    id: "original-result-id",
    call_id: call.call_id,
    output: "42",
  });
  const cold = await NativeHistory.load(
    dir,
    "https://api.mistral.ai/v1",
    model.id,
    "mistral",
  );
  const next = envelope(source, cold).wire;
  assert.deepEqual(next.messages[3], saved.message);
  assert.deepEqual(next.messages[4], {
    role: "tool",
    tool_call_id: call.call_id,
    content: "42",
  });
  assert.deepEqual(await readdir(dir), ["mistral-history.key"]);
  const changed = structuredClone(source);
  changed.input.find((x: any) => x.type === "custom_tool_call").input =
    "text(99)";
  assert.throws(() => envelope(changed, cold), /differs/);
  assert.throws(() =>
    new NativeHistory(
      Buffer.alloc(32, 9),
      "controlled-mistral-domain",
      "gemini",
    ).restore(final.output[0].encrypted_content),
  );
  assert.throws(() =>
    cold.restore(final.output[0].encrypted_content.slice(0, -8) + "AAAAAAAA"),
  );
});

test("Mistral maps long original Core call/result IDs reversibly and preserves plain reasoning without signatures", () => {
  const source = request();
  source.input.push(
    {
      type: "reasoning",
      id: "original-reason",
      content: [{ type: "reasoning_text", text: "Original plain thought" }],
      summary: [],
    },
    {
      type: "custom_tool_call",
      id: "original-item",
      call_id: "original-Core-long-call-id",
      namespace: "functions",
      name: "exec",
      input: "text(7)",
    },
    {
      type: "custom_tool_call_output",
      id: "original-result",
      call_id: "original-Core-long-call-id",
      output: "7",
    },
  );
  const first = envelope(source),
    second = envelope(source);
  assert.deepEqual(first.wire, second.wire);
  const call = first.wire.messages[3].tool_calls[0];
  assert.match(call.id, /^[A-Za-z0-9]{9}$/);
  assert.equal(first.wire.messages[4].tool_call_id, call.id);
  assert.deepEqual(first.wire.messages[3].content, [
    {
      type: "thinking",
      thinking: [{ type: "text", text: "Original plain thought" }],
    },
  ]);
  const retained = first.e.metadata.find((x) => x.path === "$.input")!
    .value as any[];
  assert.equal(retained.at(-2).call_id, "original-Core-long-call-id");
  assert.equal(retained.at(-1).id, "original-result");
});

test("Mistral parallel calls retain indexes and original IDs even when streamed out of order", async () => {
  const { e, source, wire } = envelope();
  const name = wire.tools[0].function.name;
  const frames = mistralFrames(
    "parallel",
    [
      {
        tool_calls: [
          {
            index: 1,
            id: "second001",
            function: { name, arguments: '{"input":"2' },
          },
        ],
      },
      {
        tool_calls: [
          {
            index: 0,
            id: "first0001",
            function: { name, arguments: '{"input":"1"}' },
          },
          { index: 1, function: { arguments: '"}' } },
        ],
      },
    ],
    "tool_calls",
  );
  const final = (await convert(frames, e)).at(-1).response;
  const calls = final.output.filter((x: any) => x.type === "custom_tool_call");
  assert.deepEqual(
    calls.map((x: any) => [x.call_id, x.input]),
    [
      ["second001", "2"],
      ["first0001", "1"],
    ],
  );
  source.input.push(
    ...final.output,
    ...calls.toReversed().map((x: any) => ({
      type: "custom_tool_call_output",
      call_id: x.call_id,
      output: x.input,
    })),
  );
  const next = envelope(source, e.history).wire;
  assert.deepEqual(
    next.messages.slice(-2).map((x: any) => x.tool_call_id),
    ["first0001", "second001"],
  );
});

test("Mistral rejects native-ID collisions, duplicate historical IDs and response reuse of a historical call", async () => {
  const source = request(),
    original = "original-long-core-id";
  const collision = createHash("sha256")
    .update(`synora-mistral-call-v1:${original}`)
    .digest("hex")
    .slice(0, 9);
  const pair = (id: string) => [
    {
      type: "custom_tool_call",
      call_id: id,
      namespace: "functions",
      name: "exec",
      input: "42",
    },
    { type: "custom_tool_call_output", call_id: id, output: "42" },
  ];
  source.input.push(...pair(original));
  assert.throws(
    () => envelope({ ...source, input: [...source.input, ...pair(collision)] }),
    /collision/,
  );
  assert.throws(
    () => envelope({ ...source, input: [...source.input, ...pair(original)] }),
    /Duplicate/,
  );
  const { e, wire } = envelope(source);
  await assert.rejects(
    convert(
      mistralFrames(
        "reused",
        [
          {
            tool_calls: [
              {
                index: 0,
                id: original,
                function: {
                  name: wire.tools[0].function.name,
                  arguments: '{"input":"42"}',
                },
              },
            ],
          },
        ],
        "tool_calls",
      ),
      e,
    ),
    /historical identity/,
  );
});

test("Mistral holds fragmented names until the mounted identity is known and preserves subsequent null signatures", async () => {
  const { e, wire } = envelope(),
    name = wire.tools[0].function.name;
  const result = await convert(
    mistralFrames(
      "fragmented-name",
      [
        {
          content: [
            {
              type: "thinking",
              thinking: [{ type: "text", text: "Reason" }],
              signature: "original-signature",
              closed: false,
            },
          ],
        },
        {
          content: [
            { type: "thinking", thinking: [], signature: null, closed: true },
          ],
        },
        {
          tool_calls: [
            {
              index: 0,
              id: "fragment1",
              function: { name: name.slice(0, 12), arguments: '{"input":' },
            },
          ],
        },
        {
          tool_calls: [
            {
              index: 0,
              function: { name: name.slice(12), arguments: '"42"}' },
            },
          ],
        },
      ],
      "tool_calls",
    ),
    e,
  );
  const final = result.at(-1).response,
    saved = e.history.restore(final.output[0].encrypted_content) as any;
  assert.equal(saved.message.content[0].signature, "original-signature");
  assert.equal(saved.frames[1].choices[0].delta.content[0].signature, null);
  assert.equal(final.output[1].input, "42");
  assert.equal(
    result.filter(
      (x) =>
        x.type === "response.output_item.added" &&
        x.item.type === "custom_tool_call",
    ).length,
    1,
  );
});

test("Mistral string/array/empty signed text transitions preserve the exact native history", async () => {
  const { e, source } = envelope();
  const deltas = [
    { content: "Hello " },
    {
      content: [
        {
          type: "thinking",
          thinking: [],
          signature: "empty-signature",
          closed: true,
        },
        { type: "text", text: "world" },
      ],
    },
    { content: " €" },
  ];
  const final = (await convert(mistralFrames("text", deltas), e)).at(
    -1,
  ).response;
  const saved = e.history.restore(final.output[0].encrypted_content) as any;
  assert.deepEqual(saved.message.content, [
    { type: "text", text: "Hello " },
    {
      type: "thinking",
      thinking: [],
      signature: "empty-signature",
      closed: true,
    },
    { type: "text", text: "world" },
    { type: "text", text: " €" },
  ]);
  source.input.push(...final.output, { role: "user", content: "Continue" });
  assert.deepEqual(envelope(source, e.history).wire.messages[3], saved.message);
});

test("Mistral validates returned function arguments against the exact original nested schema", async () => {
  const schema = {
    type: "object",
    properties: {
      target: {
        type: "object",
        properties: { path: { type: "string", minLength: 1 } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    required: ["target"],
    additionalProperties: false,
  };
  for (const args of [
    { target: { path: "file" } },
    { target: { path: 42 } },
    { target: { path: "" } },
    { target: { path: "file", hidden: true } },
    { target: {} },
    {},
  ]) {
    const source = request();
    source.tools = [
      { type: "function", name: "read", parameters: schema, strict: false },
    ];
    const { e, wire } = envelope(source);
    assert.deepEqual(wire.tools[0].function.parameters, schema);
    const result = convert(
      mistralFrames(
        "schema",
        [
          {
            tool_calls: [
              {
                index: 0,
                id: "schema001",
                function: {
                  name: wire.tools[0].function.name,
                  arguments: JSON.stringify(args),
                },
              },
            ],
          },
        ],
        "tool_calls",
      ),
      e,
    );
    if ((args as any).target?.path === "file" && !(args as any).target.hidden)
      assert.equal((await result).at(-1).type, "response.completed");
    else await assert.rejects(result, /original schema/);
  }
});

test("Mistral structured output preserves and validates the original schema", async () => {
  for (const answer of ['{"answer":42}', '{"answer":"wrong"}', "not-json"]) {
    const source = request();
    source.tools = [];
    source.text = {
      format: {
        type: "json_schema",
        name: "Answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "integer" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    };
    const { e, wire } = envelope(source);
    assert.deepEqual(
      wire.response_format.json_schema.schema,
      source.text.format.schema,
    );
    const result = convert(mistralFrames("json", [{ content: answer }]), e);
    if (answer === '{"answer":42}')
      assert.equal((await result).at(-1).type, "response.completed");
    else await assert.rejects(result, /contract|schema/);
  }
});

test("Mistral unmapped requests, invalid history and unvalidatable schemas fail explicitly", () => {
  for (const mutate of [
    (x: any) => (x.unknown = true),
    (x: any) => (x.model = "foreign"),
    (x: any) => (x.store = true),
    (x: any) => (x.reasoning.effort = "medium"),
    (x: any) => (x.reasoning.summary = "auto"),
    (x: any) => (x.previous_response_id = "lost-history"),
    (x: any) => (x.background = "bad"),
    (x: any) => (x.parallel_tool_calls = "false"),
    (x: any) => (x.max_output_tokens = 0),
    (x: any) =>
      x.input.push({ type: "reasoning", encrypted_content: "foreign" }),
    (x: any) =>
      x.input.push({
        type: "function_call_output",
        call_id: "orphan",
        output: "42",
      }),
    (x: any) =>
      x.input.push({
        role: "user",
        content: [{ type: "input_file", file_id: "f" }],
      }),
    (x: any) =>
      x.input.push({
        role: "user",
        content: [
          { type: "input_image", image_url: "https://secret.invalid/image" },
        ],
      }),
    (x: any) =>
      (x.tools = [
        {
          type: "function",
          name: "bad",
          parameters: { type: "object", unknownValidation: true },
        },
      ]),
  ]) {
    const source = request();
    mutate(source);
    assert.throws(() => envelope(source));
  }
  const source = request();
  source.tools = Array.from({ length: 129 }, (_, i) => ({
    type: "custom",
    name: `tool${i}`,
  }));
  assert.throws(() => envelope(source), /maximum of 128/);
});

test("Mistral unknown tools, duplicate IDs, invalid JSON, ignored forced choice and parallel violations never finish successfully", async () => {
  for (const mode of [
    "unknown",
    "bad-json",
    "duplicate",
    "parallel",
    "required",
    "none",
    "name-change",
  ]) {
    const source = request();
    if (mode === "parallel") source.parallel_tool_calls = false;
    if (["required", "none"].includes(mode)) source.tool_choice = mode;
    const { e, wire } = envelope(source),
      name = wire.tools[0].function.name;
    const first = {
      index: 0,
      id: "original1",
      function: {
        name: mode === "unknown" ? "invented" : name,
        arguments: mode === "bad-json" ? "{" : '{"input":"42"}',
      },
    };
    const deltas: any[] =
      mode === "required"
        ? [{ content: "No call" }]
        : [{ tool_calls: [first] }];
    if (["duplicate", "parallel"].includes(mode))
      deltas.push({
        tool_calls: [
          {
            ...first,
            index: 1,
            id: mode === "duplicate" ? first.id : "original2",
          },
        ],
      });
    if (mode === "name-change")
      deltas.push({
        tool_calls: [{ index: 0, function: { name: "different" } }],
      });
    await assert.rejects(
      convert(
        mistralFrames(
          mode,
          deltas,
          mode === "required" ? "stop" : "tool_calls",
        ),
        e,
      ),
    );
  }
});

test("Mistral incomplete/error reasons and absent usage remain honest; partial custom calls are not dispatched", async () => {
  for (const [reason, status] of [
    ["length", "incomplete"],
    ["model_length", "incomplete"],
    ["error", "failed"],
    ["content_filter", "failed"],
    ["unknown_reason", "failed"],
  ]) {
    const { e } = envelope();
    const final = (
      await convert(
        mistralFrames(reason, [{ content: "partial" }], reason, null),
        e,
      )
    ).at(-1).response;
    assert.equal(final.status, status);
    assert.equal(final.usage, undefined);
  }
  const { e, wire } = envelope();
  const result = await convert(
    mistralFrames(
      "partial-call",
      [
        {
          tool_calls: [
            {
              index: 0,
              id: "partial01",
              function: {
                name: wire.tools[0].function.name,
                arguments: '{"input":"part',
              },
            },
          ],
        },
      ],
      "length",
    ),
    e,
  );
  assert.equal(result.at(-1).type, "response.incomplete");
  assert.equal(
    result.some(
      (x) =>
        x.type === "response.output_item.done" &&
        x.item.type === "custom_tool_call",
    ),
    false,
  );
  assert.equal(result.at(-1).response.output[1].input, "part");
  const failure = await convert(
    [{ error: { code: "overloaded", message: "controlled error" } }],
    envelope().e,
  );
  assert.equal(failure.at(-1).type, "response.failed");
});

test("Mistral malformed/truncated SSE, mutated identities, inconsistent usage and unsupported chunks are not success", async () => {
  for (const mutate of [
    (f: any[]) => f.slice(0, -1),
    (f: any[]) => [f[0], { ...f[1], id: "changed" }],
    (f: any[]) => [f[0], { ...f[1], model: "changed" }],
    (f: any[]) => [...f, f[0]],
    (f: any[]) => [
      f[0],
      {
        ...f[1],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 99 },
      },
    ],
    (f: any[]) => [f[0], { ...f[1], usage: { prompt_tokens: -1 } }],
    (f: any[]) => [{ ...f[0], choices: [{ index: 1, delta: {} }] }, f[1]],
    (f: any[]) => [
      {
        ...f[0],
        choices: [
          {
            index: 0,
            delta: { content: [{ type: "reference", reference_ids: [1] }] },
            finish_reason: null,
          },
        ],
      },
      f[1],
    ],
  ])
    await assert.rejects(
      convert(
        mutate(mistralFrames("native", [{ content: "x" }])),
        envelope().e,
      ),
    );
  await assert.rejects(
    convert(mistralFrames("native", [{ content: "x" }]), envelope().e, false),
    /terminal marker/,
  );
  for (const bad of [
    Buffer.from("data: {bad}\n\n"),
    Buffer.from("data: {}"),
    Buffer.from([0xff, 0x0a, 0x0a]),
  ])
    await assert.rejects(convert(bad, envelope().e));
});

test("Mistral shared private bridge streams immediately, authenticates only by upstream header, and cancels owned sockets", async (t) => {
  let mode = "stream",
    release: (() => void) | undefined,
    terminated = false,
    closed = 0;
  const seen: any[] = [];
  const s = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    seen.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (mode === "error") {
      res.writeHead(429);
      res.end("controlled-key overload");
      return;
    }
    res.once("close", () => closed++);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = mistralFrames("http-native", [
      { content: "Immediate text" },
    ]);
    res.write(mistralSse(frames.slice(0, -1), false));
    if (mode === "stream")
      release = () => {
        terminated = true;
        res.end(mistralSse(frames.slice(-1)));
      };
  });
  const url = await listen(s);
  t.after(() => close(s));
  const bridge = await mistralBridge({
    endpoint: url,
    token: "controlled-key",
    model,
    history: history(),
    deadlineMs: 1000,
  });
  t.after(() => bridge.close());
  const options = {
    method: "POST",
    headers: {
      [PROVIDER_TOKEN_HEADER]: bridge.token,
      "content-type": "application/json",
      authorization: "Bearer CORE-SECRET",
    },
    body: JSON.stringify(request()),
  };
  assert.equal(
    (await fetch(`${bridge.endpoint}/responses`, { ...options, headers: {} }))
      .status,
    403,
  );
  const response = await fetch(`${bridge.endpoint}/responses`, options),
    reader = response.body!.getReader();
  let output = "";
  while (!output.includes("response.output_text.delta")) {
    const x = await reader.read();
    assert.equal(x.done, false);
    output += new TextDecoder().decode(x.value);
  }
  assert.equal(terminated, false);
  assert.doesNotMatch(output, /response.completed/);
  release!();
  for (;;) {
    const x = await reader.read();
    if (x.done) break;
    output += new TextDecoder().decode(x.value);
  }
  assert.match(output, /response.completed/);
  assert.equal(seen[0].url, "/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, "Bearer controlled-key");
  assert.equal(seen[0].headers[PROVIDER_TOKEN_HEADER], undefined);
  assert.doesNotMatch(JSON.stringify(seen[0]), /CORE-SECRET/);
  mode = "error";
  const error = await fetch(`${bridge.endpoint}/responses`, options);
  assert.equal(error.status, 429);
  assert.doesNotMatch(await error.text(), /controlled-key/);
  mode = "hold";
  const controller = new AbortController();
  const hold = await fetch(`${bridge.endpoint}/responses`, {
    ...options,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(hold.text());
  const deadline = await fetch(`${bridge.endpoint}/responses`, options);
  await assert.rejects(deadline.text());
  assert.ok(closed >= 3);
  const last = await fetch(`${bridge.endpoint}/responses`, options);
  await bridge.close();
  await assert.rejects(last.text());
});
