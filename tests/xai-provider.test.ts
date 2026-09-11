import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  XaiEnvelope,
  xaiEndpoint,
  xaiBridge,
  xaiModels,
  validateXaiSelection,
  XAI_TOKEN_HEADER,
} from "../src/engine/xai-provider";
import { configSchema, type ModelCapabilities } from "../src/shared/contracts";

const key = "SYNORA-DISPOSABLE-UNIT-KEY";
const model: ModelCapabilities = {
  id: "grok-4.6",
  context_window: 500000,
  context_window_options: [],
  reasoning_efforts: ["low", "medium", "high", "xhigh"],
};
const body = () => ({
  model: model.id,
  stream: true,
  store: false,
  input: [
    {
      type: "message",
      id: "original-user",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "original-session",
  tools: [] as any[],
});
test("xAI envelope retains history, instructions, metadata ownership, original schemas and wire identities", () => {
  const source: any = body();
  source.instructions = "Original instructions";
  source.client_metadata = { session_id: "session", turn_id: "turn" };
  source.input[0].internal_chat_message_metadata_passthrough = {
    correlation: "original",
  };
  source.tools = [
    {
      type: "namespace",
      name: "functions",
      tools: [
        {
          type: "custom",
          name: "exec",
          description: "Real Core code executor",
        },
        {
          type: "function",
          name: "optional",
          parameters: {
            type: "object",
            properties: {
              x: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: [],
          },
          strict: false,
        },
      ],
    },
  ];
  source.input.push(
    {
      type: "custom_tool_call",
      id: "item",
      call_id: "call",
      name: "exec",
      namespace: "functions",
      input: "text(3)",
    },
    {
      type: "custom_tool_call_output",
      id: "result",
      call_id: "call",
      output: "3",
    },
  );
  const original = JSON.stringify(source),
    envelope = new XaiEnvelope(model),
    wire = JSON.parse(envelope.request(Buffer.from(original)).toString());
  assert.equal(JSON.stringify(source), original);
  assert.equal(wire.instructions, source.instructions);
  assert.equal(wire.prompt_cache_key, "original-session");
  assert.equal(wire.input[0].id, "original-user");
  assert.equal(wire.input[1].id, "item");
  assert.equal(wire.input[1].call_id, "call");
  assert.equal(wire.input[2].id, "result");
  assert.equal(wire.input[2].output, "3");
  assert.deepEqual(
    wire.tools[1].parameters,
    source.tools[0].tools[1].parameters,
  );
  assert.equal(wire.tools[1].strict, false);
  assert.equal(wire.client_metadata, undefined);
  assert.equal(
    wire.input[0].internal_chat_message_metadata_passthrough,
    undefined,
  );
  assert.equal(envelope.metadata.length, 2);
  assert.deepEqual(envelope.tools.counts, {
    advertised: 2,
    translated: 2,
    rejected: 0,
  });
});
test("xAI rejects unsupported envelope fields without altering request semantics", () => {
  const cases = [
    { model: "other" },
    { stream: false },
    { store: true },
    { background: true },
    { truncation: "auto" },
    { context_management: [{ type: "compaction" }] },
    { include: ["message.output_text.logprobs"] },
    { text: { verbosity: "low" } },
    { reasoning: { effort: "none" } },
    { client_metadata: "bad" },
    { input: [{ type: "unknown" }] },
    { input: [{ type: "message", arbitrary: true }] },
  ];
  for (const value of cases)
    assert.throws(
      () =>
        new XaiEnvelope(model).request(
          Buffer.from(JSON.stringify({ ...body(), ...value })),
        ),
      { code: "XAI_COMPATIBILITY" },
    );
  assert.throws(
    () => new XaiEnvelope(model).request(Buffer.from([0xff])),
    /UTF-8/,
  );
  assert.throws(
    () => new XaiEnvelope(model).request(Buffer.from("null")),
    /object/,
  );
});
test("xAI config separates original Core account and Axiom credentials and validates endpoint scope", () => {
  const value = {
    id: "xai",
    name: "xAI",
    kind: "provider",
    providerType: "xai",
    auth: "api-key",
    endpoint: "https://api.x.ai/v1",
    enabled: true,
    tools: [],
  };
  assert.equal(configSchema.parse(value).providerType, "xai");
  for (const v of [
    { auth: "none" },
    { auth: "core-account" },
    { tools: ["bash"] },
    { kind: "connector" },
  ])
    assert.equal(configSchema.safeParse({ ...value, ...v }).success, false);
  assert.equal(xaiEndpoint("https://api.x.ai/v1/"), value.endpoint);
  for (const url of [
    "http://example.org/v1",
    "https://a:b@example.org/v1",
    "https://api.x.ai/v1?q=a",
    "https://api.x.ai/v1/other",
    "https://api.x.ai/v1#x",
  ])
    assert.throws(() => xaiEndpoint(url));
  assert.throws(
    () => validateXaiSelection([model], model.id, "none"),
    /effort/,
  );
  assert.throws(
    () =>
      validateXaiSelection(
        [{ ...model, unavailableReason: "not qualified" }],
        model.id,
      ),
    /not qualified/,
  );
});

test("xAI private bridge: credentials, incremental SSE, terminal failure, deadlines, disconnect and bounded errors", async () => {
  let mode = "normal",
    calls = 0,
    closes = 0;
  const wireRequests: any[] = [];
  let releaseCompletion!: () => void;
  const completionAllowed = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const upstream = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers[XAI_TOKEN_HEADER], undefined);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/v1/language-models") {
      res.end(
        JSON.stringify({
          models: [
            {
              id: "grok-4.6",
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            {
              id: "unknown",
              input_modalities: ["text"],
              output_modalities: ["text"],
            },
          ],
        }),
      );
      return;
    }
    wireRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (mode === "error") {
      res.writeHead(429);
      res.end(JSON.stringify({ error: `Rate limited ${key}` }));
      return;
    }
    if (mode === "redirect") {
      res.writeHead(307, { location: "/do-not-follow" });
      res.end();
      return;
    }
    res.once("close", () => {
      closes++;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'data: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n',
    );
    if (mode === "hold") return;
    res.write(
      'data: {"type":"response.output_text.delta","item_id":"m","delta":"FIRST"}\n\n',
    );
    // Completion is held until the client observes text. This proves actual
    // incremental forwarding independently of TCP/fetch chunk boundaries.
    if (mode === "normal") await completionAllowed;
    else await delay(40);
    if (mode === "truncated") {
      res.end();
      return;
    }
    res.end(
      'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const bridge = await xaiBridge({
    endpoint,
    token: key,
    model,
    deadlineMs: 300,
  });
  const request = (signal?: AbortSignal, extra = {}) =>
    fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      signal,
      headers: {
        [XAI_TOKEN_HEADER]: bridge.token,
        "content-type": "application/json",
        authorization: "Bearer NOT-THE-XAI-KEY",
        cookie: "must-not-leak",
        ...extra,
      },
      body: JSON.stringify(body()),
    });
  try {
    const catalog = await xaiModels(endpoint, key);
    assert.equal(catalog[0].context_window, 500000);
    assert.ok(catalog[1].unavailableReason);
    assert.equal(catalog[1].context_window, null);
    const before = calls;
    assert.equal(
      (await request(undefined, { [XAI_TOKEN_HEADER]: "wrong" })).status,
      403,
    );
    assert.equal(
      (await request(undefined, { origin: "https://untrusted.example" }))
        .status,
      403,
    );
    assert.equal(calls, before);
    const response = await request();
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let first = "";
    while (!first.includes("FIRST")) {
      const next = await reader.read();
      assert.equal(
        next.done,
        false,
        "stream ended before the first text delta",
      );
      first += decoder.decode(next.value, { stream: true });
    }
    assert.match(first, /FIRST/);
    assert.match(first, /response.created/);
    assert.doesNotMatch(first, /response.completed/);
    releaseCompletion();
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    assert.match(rest, /response.completed/);
    assert.match(rest, /\[DONE\]/);
    mode = "error";
    const limited = await request();
    assert.equal(limited.status, 429);
    const error = await limited.text();
    assert.match(error, /Rate limited/);
    assert.ok(!error.includes(key));
    mode = "redirect";
    const count = calls;
    const redirected = await request();
    assert.equal(redirected.status, 502);
    await redirected.text();
    assert.equal(calls, count + 1);
    mode = "truncated";
    const truncated = await request();
    await assert.rejects(truncated.text());
    mode = "hold";
    const held = await request();
    await assert.rejects(held.text());
    const controller = new AbortController();
    const countClosed = closes;
    const disconnect = await request(controller.signal);
    controller.abort();
    await assert.rejects(disconnect.text());
    for (let i = 0; i < 100 && closes === countClosed; i++) await delay(5);
    assert.ok(closes > countClosed);
    assert.ok(
      wireRequests.every(
        (v) => v.store === false && v.prompt_cache_key === "original-session",
      ),
    );
  } finally {
    releaseCompletion();
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
