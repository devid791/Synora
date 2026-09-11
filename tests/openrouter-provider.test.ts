import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  openRouterEndpoint,
  openRouterModels,
  validateOpenRouterSelection,
  OpenRouterEnvelope,
  openRouterBridge,
} from "../src/engine/openrouter-provider";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import { configSchema, type ModelCapabilities } from "../src/shared/contracts";
const model: ModelCapabilities = {
  id: "fixture/model",
  context_window: 100000,
  context_window_options: [],
  reasoning_efforts: ["high", "low"],
};
const body = () => ({
  model: model.id,
  stream: true,
  store: false,
  instructions: "Original instructions",
  client_metadata: { session_id: "session-original" },
  prompt_cache_key: "original-cache",
  input: [{ type: "message", role: "user", content: "Hello" }],
  tools: [],
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
});

test("OpenRouter configuration/endpoint cannot send keys to another site or adopt Axiom profiles", () => {
  const v = {
    id: "or",
    name: "OpenRouter",
    kind: "provider",
    providerType: "openrouter",
    endpoint: "https://openrouter.ai/api/v1",
    auth: "api-key",
    enabled: true,
    tools: [],
  };
  assert.equal(configSchema.parse(v).providerType, "openrouter");
  for (const change of [
    { auth: "core-account" },
    { auth: "oauth" },
    { tools: ["bash"] },
    { kind: "connector" },
  ])
    assert.equal(configSchema.safeParse({ ...v, ...change }).success, false);
  assert.equal(openRouterEndpoint(v.endpoint + "/"), v.endpoint);
  for (const url of [
    "https://other.invalid/api/v1",
    "https://openrouter.ai/api/v1?key=secret",
    "https://user:password@openrouter.ai/api/v1",
    "http://openrouter.ai/api/v1",
  ])
    assert.throws(() => openRouterEndpoint(url));
  assert.equal(
    openRouterEndpoint("http://127.0.0.1:1234/v1"),
    "http://127.0.0.1:1234/v1",
  );
  assert.throws(
    () => validateOpenRouterSelection([model], model.id, "xhigh"),
    /effort/,
  );
});
test("OpenRouter retains phase, reasoning signatures, parallel original tool IDs, metadata and code through reversible encoding", () => {
  const source: any = body();
  source.tools = [
    {
      type: "namespace",
      name: "functions",
      tools: [
        { type: "custom", name: "exec", description: "Original executor" },
      ],
    },
  ];
  source.input.push(
    {
      type: "message",
      id: "assistant-id",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "Working", annotations: [] }],
      internal_chat_message_metadata_passthrough: { identity: "local" },
    },
    {
      type: "reasoning",
      id: "thinking-id",
      signature: "unchanged-signature",
      encrypted_content: "opaque",
      summary: [],
    },
    {
      type: "custom_tool_call",
      id: "call-item",
      call_id: "call-original",
      name: "exec",
      namespace: "functions",
      input: "text(42)",
    },
    {
      type: "custom_tool_call_output",
      id: "result-item",
      call_id: "call-original",
      output: "42",
    },
  );
  const before = JSON.stringify(source),
    envelope = new OpenRouterEnvelope(model),
    wire = JSON.parse(envelope.request(Buffer.from(before)).toString());
  assert.equal(JSON.stringify(source), before);
  assert.equal(wire.input[1].phase, "commentary");
  assert.equal(wire.input[2].signature, "unchanged-signature");
  assert.equal(wire.input[2].encrypted_content, "opaque");
  assert.equal(wire.input[3].call_id, "call-original");
  assert.equal(wire.input[4].id, "result-item");
  assert.equal(wire.input[4].output, "42");
  assert.equal(wire.parallel_tool_calls, true);
  assert.equal(wire.prompt_cache_key, "original-cache");
  assert.deepEqual(wire.provider, { require_parameters: true });
  assert.deepEqual(envelope.metadata, [
    { path: "$.client_metadata", value: source.client_metadata },
    {
      path: "$.input[1].internal_chat_message_metadata_passthrough",
      value: { identity: "local" },
    },
  ]);
  assert.equal(wire.tools[0].type, "function");
  assert.equal(JSON.parse(wire.input[3].arguments).input, "text(42)");
});
test("OpenRouter rejects unsupported history references, fields and overrides without silent removal", () => {
  for (const change of [
    { store: true },
    { previous_response_id: "old" },
    { stream: false },
    { truncation: "auto" },
    { model: "other" },
    { input: [{ type: "unknown" }] },
    { reasoning: { effort: "invented" } },
    { reasoning: { generate_summary: true } },
    { context_window: 1048576 },
  ])
    assert.throws(
      () =>
        new OpenRouterEnvelope(model).request(
          Buffer.from(JSON.stringify({ ...body(), ...change })),
        ),
      { code: "OPENROUTER_COMPATIBILITY" },
    );
  assert.throws(
    () => new OpenRouterEnvelope(model).request(Buffer.from([0xff])),
    /UTF-8/,
  );
});
test("OpenRouter reads all user-catalog pages and real model metadata; never follows cross-origin or unfiltered links", async (t) => {
  let mode = "normal";
  const requests: string[] = [];
  const item = {
    id: model.id,
    name: "Fixture model",
    context_length: 200000,
    top_provider: { context_length: 100000 },
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
    },
    supported_parameters: ["tools"],
    reasoning: {
      mandatory: true,
      supported_efforts: ["high", "low", "none"],
      default_enabled: true,
      default_effort: "high",
    },
  };
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    requests.push(req.url!);
    if (mode === "denied") {
      res.writeHead(401);
      res.end("secret-key");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.includes("page=2")
          ? {
              data: [
                { ...item, id: "fixture/no-tools", supported_parameters: [] },
              ],
              links: { next: null },
            }
          : {
              data: [item],
              links: {
                next:
                  mode === "origin"
                    ? "https://other.invalid/models/user"
                    : mode === "scope"
                      ? "/v1/models?page=2"
                      : mode === "loop"
                        ? "/v1/models/user"
                        : "/v1/models/user?page=2",
              },
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const models = await openRouterModels(endpoint, "fixture-key");
  assert.equal(models.length, 2);
  assert.equal(models[0].context_window, 100000);
  assert.deepEqual(models[0].reasoning_efforts, ["high", "low"]);
  assert.equal(models[0].default_reasoning_effort, "high");
  assert.match(models[1].unavailableReason!, /tool/);
  assert.deepEqual(requests, ["/v1/models/user", "/v1/models/user?page=2"]);
  for (mode of ["origin", "scope", "loop"])
    await assert.rejects(
      openRouterModels(endpoint, "fixture-key"),
      /pagination/,
    );
  mode = "denied";
  await assert.rejects(openRouterModels(endpoint, "fixture-key"), /HTTP 401/);
});
test("OpenRouter private SSE transport keeps ordered text/final response and refuses incomplete streams", async (t) => {
  let ended = false,
    mode = "normal";
  let release!: () => void, arrived!: () => void;
  const allowFinal = new Promise<void>((r) => {
    release = r;
  });
  const haveDelta = new Promise<void>((r) => {
    arrived = r;
  });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const sent = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(sent.provider, { require_parameters: true });
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (data: unknown) =>
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    send({ type: "response.created", response: { id: "original-response" } });
    send({
      type: "response.output_text.delta",
      item_id: "original-item",
      output_index: 0,
      content_index: 0,
      delta: "Hello",
    });
    arrived();
    await allowFinal;
    if (mode === "normal")
      send({
        type: "response.completed",
        response: { id: "original-response", status: "completed", output: [] },
      });
    ended = true;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  const bridge = await openRouterBridge({
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    token: "fixture-key",
    model,
  });
  t.after(() => bridge.close());
  const invoke = () =>
    fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(3000),
      headers: { [PROVIDER_TOKEN_HEADER]: bridge.token },
      body: JSON.stringify(body()),
    });
  const response = await invoke();
  await haveDelta;
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  let first = "";
  // TCP/fetch can split the created event from the following text delta.
  // Hold upstream completion until text is observed, so full buffering still
  // fails; a request deadline makes a missing delta fail instead of hanging.
  while (!first.includes('"delta":"Hello"')) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "Stream ended before its incremental text");
    first += decoder.decode(value, { stream: true });
  }
  assert.equal(ended, false);
  assert.match(first, /Hello/);
  assert.doesNotMatch(first, /response.completed/);
  release();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assert.match(text, /response.completed/);
  mode = "truncated";
  const incomplete = await invoke();
  await assert.rejects(incomplete.text());
});
