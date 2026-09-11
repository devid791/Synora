import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, stat, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicHistory } from "../src/engine/anthropic-history";
import { AnthropicEnvelope } from "../src/engine/anthropic-envelope";
import { AnthropicStream } from "../src/engine/anthropic-stream";
import {
  anthropicBridge,
  anthropicEndpoint,
  anthropicModels,
  validateAnthropicSelection,
} from "../src/engine/anthropic-provider";
import { ResponsesToolStream } from "../src/engine/responses-tool-codec";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import { configSchema, type ModelCapabilities } from "../src/shared/contracts";
import {
  anthropicFixtureModel as nativeModel,
  nativeEvents,
  nativeSse,
} from "./fixtures/anthropic-wire";
const model: ModelCapabilities = {
  id: nativeModel.id,
  context_window: 200000,
  context_window_options: [],
  reasoning_efforts: ["low", "high"],
  providerModel: {
    provider: "anthropic",
    description: "Fixture",
    aliases: [],
    inputModalities: ["text", "image"],
    anthropic: {
      maxOutput: 32768,
      structuredOutputs: true,
      adaptiveThinking: true,
    },
  },
};
const history = () => new AnthropicHistory(Buffer.alloc(32, 9), "test-domain");
const request = (): any => ({
  model: model.id,
  stream: true,
  store: false,
  instructions: "Original instructions",
  input: [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Workspace instructions" }],
    },
    { type: "message", role: "user", content: "Read a file" },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      tools: [{ type: "custom", name: "exec", description: "Executor" }],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
  include: ["reasoning.encrypted_content"],
  client_metadata: { session_id: "original-session" },
  prompt_cache_key: "original-cache",
});
async function convert(events: any[], envelope: AnthropicEnvelope) {
  const bytes = nativeSse(events),
    chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 11)
    chunks.push(bytes.subarray(i, i + 11));
  let out = "";
  await pipeline(
    Readable.from(chunks),
    new AnthropicStream(envelope),
    new ResponsesToolStream(envelope.tools),
    async (source) => {
      for await (const c of source) out += c;
    },
  );
  return out
    .split("\n\n")
    .filter((x) => x.includes("data:"))
    .map((x) =>
      JSON.parse(
        x
          .split("\n")
          .find((x) => x.startsWith("data:"))!
          .slice(5),
      ),
    );
}
test("Anthropic endpoint and authenticated paginated catalog preserve authoritative model capabilities", async (t) => {
  const config = {
    id: "claude",
    name: "Claude API",
    kind: "provider",
    providerType: "anthropic",
    auth: "api-key",
    endpoint: "https://api.anthropic.com/v1",
    enabled: true,
    tools: [],
  };
  assert.equal(configSchema.parse(config).providerType, "anthropic");
  for (const invalid of [
    { auth: "core-account" },
    { auth: "oauth" },
    { auth: "none" },
    { tools: ["bash"] },
    { kind: "connector" },
  ])
    assert.equal(
      configSchema.safeParse({ ...config, ...invalid }).success,
      false,
    );
  for (const endpoint of [
    "http://api.anthropic.com/v1",
    "https://other.invalid/v1",
    "https://api.anthropic.com/v1?key=x",
    "https://user:secret@api.anthropic.com/v1",
  ])
    assert.throws(() => anthropicEndpoint(endpoint));
  assert.equal(
    anthropicEndpoint("https://api.anthropic.com/v1/"),
    "https://api.anthropic.com/v1",
  );
  let bad = false;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    calls.push(req.url!);
    const second = req.url!.includes("after_id=");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: second
          ? [
              {
                ...nativeModel,
                id: "no-metadata",
                capabilities: null,
                max_input_tokens: null,
              },
            ]
          : [nativeModel],
        has_more: !second || bad,
        last_id: nativeModel.id,
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const models = await anthropicModels(endpoint, "fixture");
  assert.equal(models.length, 2);
  assert.deepEqual(models[0].reasoning_efforts, [
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.equal(models[0].context_window, 200000);
  assert.equal(models[0].providerModel!.anthropic!.maxOutput, 32768);
  assert.ok(models[1].unavailableReason);
  assert.match(calls[1], /after_id=claude-fixture-native/);
  assert.throws(() => validateAnthropicSelection(models, models[1].id));
  assert.throws(() =>
    validateAnthropicSelection(models, models[0].id, "xhigh"),
  );
  bad = true;
  await assert.rejects(anthropicModels(endpoint, "fixture"), /pagination/);
});
test("Anthropic thinking is actually sealed, provider/model-bound and cold/concurrent key creation is stable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-anthropic-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = await Promise.all(
    Array.from({ length: 8 }, () =>
      AnthropicHistory.load(
        directory,
        "https://api.anthropic.com/v1",
        model.id,
      ),
    ),
  );
  const native = {
    type: "thinking",
    thinking: "Original reasoning",
    signature: "unchanged-signature",
  };
  const sealed = keys[0].seal(native);
  assert.equal(sealed.includes(native.thinking), false);
  for (const k of keys) assert.deepEqual(k.restore(sealed), native);
  const before = await readFile(join(directory, "anthropic-history.key"));
  const cold = await AnthropicHistory.load(
    directory,
    "https://api.anthropic.com/v1",
    model.id,
  );
  assert.deepEqual(cold.restore(sealed), native);
  assert.deepEqual(
    await readFile(join(directory, "anthropic-history.key")),
    before,
  );
  assert.equal((await readdir(directory)).length, 1);
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, "anthropic-history.key"))).mode & 0o777,
      0o600,
    );
  assert.throws(() =>
    new AnthropicHistory(before, "another-model").restore(sealed),
  );
  assert.throws(() => cold.restore(sealed.slice(0, -6) + "AAAAAA"));
});
test("Anthropic native request retains full instructions, original IDs/results, images and signed reasoning", () => {
  const h = history(),
    e = new AnthropicEnvelope(model, h),
    source = request();
  const block = {
    type: "thinking",
    thinking: "Original signed reasoning",
    signature: "opaque-signature",
  };
  source.input.push(
    {
      type: "reasoning",
      id: "rs-original",
      summary: [],
      encrypted_content: h.seal(block),
    },
    {
      type: "custom_tool_call",
      id: "item-original",
      call_id: "call_original",
      namespace: "functions",
      name: "exec",
      input: "text(42)",
    },
    {
      type: "custom_tool_call_output",
      id: "result-original",
      call_id: "call_original",
      output: "42",
    },
    {
      type: "message",
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
  const before = JSON.stringify(source),
    wire = JSON.parse(e.request(Buffer.from(before)).toString());
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(
    wire.system.map((x: any) => x.text),
    ["Original instructions", "Workspace instructions"],
  );
  assert.equal(wire.max_tokens, 32768);
  assert.deepEqual(wire.output_config, { effort: "high" });
  assert.deepEqual(wire.thinking, { type: "adaptive" });
  assert.equal(wire.tool_choice.disable_parallel_tool_use, false);
  assert.deepEqual(wire.messages[1].content[0], block);
  assert.equal(wire.messages[1].content[1].id, "call_original");
  assert.deepEqual(wire.messages[1].content[1].input, { input: "text(42)" });
  assert.equal(wire.messages[2].content[0].tool_use_id, "call_original");
  assert.deepEqual(wire.messages[2].content[0].content, [
    { type: "text", text: "42" },
  ]);
  assert.equal(wire.messages[2].content[1].source.media_type, "image/png");
  assert.ok(e.metadata.some((v) => v.path === "$.client_metadata"));
  assert.equal(wire.client_metadata, undefined);
});
test("Anthropic rejects unmapped semantics, invalid overrides, foreign history and unavailable strict tools", () => {
  for (const change of [
    (v: any) => (v.unknown = true),
    (v: any) => (v.previous_response_id = "server-history"),
    (v: any) => (v.reasoning.effort = "xhigh"),
    (v: any) => (v.max_output_tokens = 32769),
    (v: any) => (v.temperature = 0.3),
    (v: any) => (v.tool_choice = "required"),
    (v: any) =>
      v.input.push({ type: "reasoning", encrypted_content: "foreign" }),
    (v: any) =>
      v.input.push({ type: "message", role: "developer", content: "late" }),
    (v: any) => v.input.push({ type: "unknown" }),
  ]) {
    const body = request();
    change(body);
    assert.throws(
      () =>
        new AnthropicEnvelope(model, history()).request(
          Buffer.from(JSON.stringify(body)),
        ),
      (e) => !!e && (e as any).code === "ANTHROPIC_COMPATIBILITY",
    );
  }
  const m = structuredClone(model);
  m.providerModel!.anthropic!.structuredOutputs = false;
  assert.throws(
    () =>
      new AnthropicEnvelope(m, history()).request(
        Buffer.from(JSON.stringify(request())),
      ),
    /strict/,
  );
});
test("Anthropic incremental SSE restores custom tools, parallel call identities and exact thinking on the next request", async () => {
  const e = new AnthropicEnvelope(model, history()),
    source = request(),
    wire = JSON.parse(
      e.request(Buffer.from(JSON.stringify(source))).toString(),
    );
  const thinking = {
    type: "thinking",
    thinking: "Check original file €",
    signature: "original-full-signature",
  };
  const blocks = [
    thinking,
    { type: "redacted_thinking", data: "opaque-redacted" },
    {
      type: "tool_use",
      id: "toolu_one",
      name: wire.tools[0].name,
      input: { input: "text(42)" },
    },
    {
      type: "tool_use",
      id: "toolu_two",
      name: wire.tools[0].name,
      input: { input: "text(43)" },
    },
  ];
  const events = await convert(
      nativeEvents("msg-native", blocks, "tool_use"),
      e,
    ),
    final = events.at(-1).response;
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(final.usage, {
    input_tokens: 35,
    output_tokens: 12,
    total_tokens: 47,
    input_tokens_details: { cached_tokens: 10 },
  });
  assert.equal(final.output[2].type, "custom_tool_call");
  assert.equal(final.output[2].input, "text(42)");
  assert.equal(final.output[2].namespace, "functions");
  assert.equal(final.output[2].call_id, "toolu_one");
  assert.equal(final.output[3].call_id, "toolu_two");
  assert.ok(
    events.some((x) => x.type === "response.custom_tool_call_input.delta"),
  );
  assert.deepEqual(
    e.history.restore(final.output[0].encrypted_content),
    thinking,
  );
  source.input.push(
    ...final.output,
    { type: "custom_tool_call_output", call_id: "toolu_one", output: "42" },
    { type: "custom_tool_call_output", call_id: "toolu_two", output: "43" },
  );
  const next = JSON.parse(
    new AnthropicEnvelope(model, e.history)
      .request(Buffer.from(JSON.stringify(source)))
      .toString(),
  );
  assert.deepEqual(next.messages[1].content.slice(0, 2), blocks.slice(0, 2));
  assert.equal(next.messages[2].content.length, 2);
});
test("Anthropic interleaved parallel blocks retain each original call and argument stream", async () => {
  const e = new AnthropicEnvelope(model, history());
  const wire = JSON.parse(
    e.request(Buffer.from(JSON.stringify(request()))).toString(),
  );
  const blocks = [
    {
      type: "tool_use",
      id: "toolu_first",
      name: wire.tools[0].name,
      input: { input: "text(1)" },
    },
    {
      type: "tool_use",
      id: "toolu_second",
      name: wire.tools[0].name,
      input: { input: "text(2)" },
    },
  ];
  const ordered = nativeEvents("msg_parallel", blocks, "tool_use");
  const start = ordered.find(
    (x) => x.type === "content_block_start" && x.index === 1,
  );
  const interleaved = [
    ordered[0],
    ordered[1],
    start,
    ...ordered.slice(2).filter((x) => x !== start),
  ];
  const result = (await convert(interleaved, e)).at(-1).response;
  assert.deepEqual(
    result.output.map((x: any) => [x.call_id, x.input]),
    [
      ["toolu_first", "text(1)"],
      ["toolu_second", "text(2)"],
    ],
  );
});
test("Anthropic incomplete, malformed, errored and truncated streams never become completed turns", async () => {
  for (const mutation of [
    (v: any[]) => v.slice(0, -1),
    (v: any[]) => [v[1], ...v],
    (v: any[]) => [...v, { type: "message_stop" }],
    (v: any[]) =>
      v.map((x) =>
        x.type === "content_block_delta"
          ? { ...x, delta: { type: "wrong" } }
          : x,
      ),
  ]) {
    const e = new AnthropicEnvelope(model, history());
    e.request(Buffer.from(JSON.stringify(request())));
    await assert.rejects(
      convert(
        mutation(nativeEvents("msg-test", [{ type: "text", text: "hi" }])),
        e,
      ),
    );
  }
  for (const reason of [
    "max_tokens",
    "model_context_window_exceeded",
    "pause_turn",
  ]) {
    const e = new AnthropicEnvelope(model, history());
    e.request(Buffer.from(JSON.stringify(request())));
    assert.equal(
      (
        await convert(
          nativeEvents("msg-test", [{ type: "text", text: "hi" }], reason),
          e,
        )
      ).at(-1).type,
      "response.incomplete",
    );
  }
  const e = new AnthropicEnvelope(model, history());
  e.request(Buffer.from(JSON.stringify(request())));
  const events = nativeEvents("msg-test", []);
  assert.equal(
    (
      await convert(
        [
          events[0],
          {
            type: "error",
            error: { type: "overloaded_error", message: "private" },
          },
        ],
        e,
      )
    ).at(-1).type,
    "response.failed",
  );
});
test("Anthropic private transport sends only native request/auth, streams before stop, cancels quiet upstream and preserves HTTP errors", async (t) => {
  let mode = "stream",
    closed = 0;
  let release!: () => void;
  const finalAllowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const received: any[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (mode === "error") {
      res.writeHead(429);
      res.end("credential-fixture upstream limit");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = nativeEvents("msg-http", [
      { type: "text", text: "Progressive text" },
    ]);
    res.write(nativeSse(events.slice(0, -2)));
    res.once("close", () => closed++);
    if (mode === "stream") {
      await finalAllowed;
      res.end(nativeSse(events.slice(-2)));
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        upstream.closeAllConnections();
        upstream.close(() => r());
      }),
  );
  const b = await anthropicBridge({
    endpoint: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    token: "credential-fixture",
    model,
    history: history(),
    deadlineMs: 500,
  });
  t.after(() => b.close());
  const opts = {
    method: "POST",
    headers: {
      [PROVIDER_TOKEN_HEADER]: b.token,
      "content-type": "application/json",
      authorization: "Bearer CORE-SECRET",
    },
    body: JSON.stringify(request()),
  };
  assert.equal(
    (await fetch(`${b.endpoint}/responses`, { ...opts, headers: {} })).status,
    403,
  );
  const r = await fetch(`${b.endpoint}/responses`, opts),
    reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let first = "";
  // Native headers/items can precede text in separate TCP reads. Completion
  // remains held until the client observes text; the bridge deadline bounds a
  // missing delta. This tests incremental delivery, not packet coalescing.
  while (!first.includes("Progressive text")) {
    const next = await reader.read();
    assert.equal(next.done, false, "Stream ended before its text delta");
    first += decoder.decode(next.value, { stream: true });
  }
  assert.match(first, /response.output_text.delta/);
  assert.doesNotMatch(first, /response.completed/);
  release();
  let tail = "";
  for (;;) {
    const x = await reader.read();
    if (x.done) break;
    tail += new TextDecoder().decode(x.value);
  }
  assert.match(tail, /response.completed/);
  assert.equal(received[0].url, "/v1/messages");
  assert.equal(received[0].headers.authorization, "Bearer credential-fixture");
  assert.equal(received[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(received[0].headers[PROVIDER_TOKEN_HEADER], undefined);
  assert.equal(received[0].body.input, undefined);
  mode = "error";
  const er = await fetch(`${b.endpoint}/responses`, opts);
  assert.equal(er.status, 429);
  assert.doesNotMatch(await er.text(), /credential-fixture/);
  mode = "hold";
  const ac = new AbortController(),
    quiet = await fetch(`${b.endpoint}/responses`, {
      ...opts,
      signal: ac.signal,
    });
  await quiet.body!.getReader().read();
  ac.abort();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(closed >= 2);
});
