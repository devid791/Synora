import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeHistory } from "../src/engine/native-history";
import { GeminiEnvelope } from "../src/engine/gemini-envelope";
import { GeminiStream } from "../src/engine/gemini-stream";
import {
  geminiBridge,
  geminiEndpoint,
  geminiModels,
  validateGeminiSelection,
} from "../src/engine/gemini-provider";
import { ResponsesToolStream } from "../src/engine/responses-tool-codec";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import { configSchema } from "../src/shared/contracts";
import {
  geminiCapabilities as model,
  geminiFixtureModel,
  geminiFrames,
  geminiSse,
} from "./fixtures/gemini-wire";
const history = () =>
  new NativeHistory(Buffer.alloc(32, 7), "test-domain", "gemini");
const request = (): any => ({
  model: model.id,
  stream: true,
  store: false,
  instructions: "Original system",
  input: [
    {
      type: "message",
      role: "developer",
      content: "Original workspace instructions",
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
  include: ["reasoning.encrypted_content"],
  client_metadata: { session_id: "original-session" },
  prompt_cache_key: "original-prefix",
});
function envelope() {
  const e = new GeminiEnvelope(model, history());
  const source = request();
  const wire = JSON.parse(
    e.request(Buffer.from(JSON.stringify(source))).toString(),
  );
  return { e, source, wire };
}
async function convert(frames: any[], e: GeminiEnvelope) {
  const bytes = geminiSse(frames),
    chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 7)
    chunks.push(bytes.subarray(i, i + 7));
  let output = "";
  await pipeline(
    Readable.from(chunks),
    new GeminiStream(e),
    new ResponsesToolStream(e.tools),
    async (source) => {
      for await (const c of source) output += c;
    },
  );
  return output
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
test("Gemini authenticated native pagination uses header-only key and exact model metadata", async (t) => {
  const config = {
    id: "google",
    name: "Google",
    kind: "provider",
    providerType: "gemini",
    auth: "api-key",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    enabled: true,
    tools: [],
  };
  assert.equal(configSchema.parse(config).providerType, "gemini");
  assert.equal(configSchema.parse({ ...config, auth: "oauth" }).auth, "oauth");
  for (const override of [
    { auth: "none" },
    { tools: ["invented"] },
  ])
    assert.equal(
      configSchema.safeParse({ ...config, ...override }).success,
      false,
    );
  for (const u of [
    "http://generativelanguage.googleapis.com/v1beta",
    "https://other.invalid/v1beta",
    "https://generativelanguage.googleapis.com/v1beta?key=secret",
    "https://user:secret@generativelanguage.googleapis.com/v1beta",
  ])
    assert.throws(() => geminiEndpoint(u));
  const seen: string[] = [];
  let bad = false;
  const s = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-goog-api-key"], "fixture");
    seen.push(req.url!);
    const second = req.url!.includes("pageToken");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        models: [
          second
            ? {
                ...geminiFixtureModel,
                name: "models/embed-fixture",
                inputTokenLimit: 0,
                outputTokenLimit: undefined,
                supportedGenerationMethods: ["embedContent"],
              }
            : geminiFixtureModel,
        ],
        ...(!second || bad ? { nextPageToken: "next" } : {}),
      }),
    );
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  );
  const url = `http://127.0.0.1:${(s.address() as any).port}/v1beta`;
  const list = await geminiModels(url, "fixture");
  assert.equal(list.length, 2);
  assert.equal(list[0].context_window, 100000);
  assert.deepEqual(list[0].reasoning_efforts, []);
  assert.equal(list[0].providerModel!.gemini!.thinking, true);
  assert.match(seen[1], /pageToken=next/);
  assert.equal(validateGeminiSelection(list, model.id).id, model.id);
  assert.throws(() => validateGeminiSelection(list, "embed-fixture"));
  assert.throws(() => validateGeminiSelection(list, model.id, "high"));
  bad = true;
  await assert.rejects(geminiModels(url, "fixture"), /cursor/);
});
test("Gemini history preserves its own atomic cold key and cannot reuse Anthropic sealed data", async (t) => {
  assert.throws(
    () => history().seal({ text: "x".repeat(8 * 1024 * 1024) }),
    /memory bound/,
  );
  const dir = await mkdtemp(join(tmpdir(), "synora-gemini-history-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keys = await Promise.all(
    Array.from({ length: 8 }, () =>
      NativeHistory.load(
        dir,
        "https://generativelanguage.googleapis.com/v1beta",
        model.id,
        "gemini",
      ),
    ),
  );
  const original = { parts: [{ text: "", thoughtSignature: "original" }] },
    sealed = keys[0].seal(original);
  for (const k of keys) assert.deepEqual(k.restore(sealed), original);
  const cold = await NativeHistory.load(
    dir,
    "https://generativelanguage.googleapis.com/v1beta",
    model.id,
    "gemini",
  );
  assert.deepEqual(cold.restore(sealed), original);
  assert.deepEqual(await readdir(dir), ["gemini-history.key"]);
  assert.throws(() =>
    new NativeHistory(Buffer.alloc(32, 7), "test-domain").restore(
      history().seal(original),
    ),
  );
  assert.throws(() => cold.restore(sealed.slice(0, -6) + "AAAAAA"));
});
test("Gemini keeps native Parts/signatures/order, parallel calls/results, exact custom identity across Core history", async () => {
  const { e, source, wire } = envelope();
  const name = wire.tools[0].functionDeclarations[0].name;
  assert.deepEqual(wire.systemInstruction.parts, [
    { text: "Original system" },
    { text: "Original workspace instructions" },
  ]);
  assert.deepEqual(wire.generationConfig.thinkingConfig, {
    includeThoughts: true,
  });
  assert.equal(wire.generationConfig.maxOutputTokens, 32768);
  assert.ok(e.metadata.some((x) => x.path === "$.client_metadata"));
  const parts = [
    { text: "Reason €", thought: true },
    {
      functionCall: { id: "native-call-1", name, args: { input: "text(42)" } },
      thoughtSignature: "sig-on-call",
    },
    { functionCall: { name, args: { input: "text(43)" } } },
    { text: "", thoughtSignature: "sig-empty-text" },
  ];
  const events = await convert(geminiFrames("native-response", parts), e),
    final = events.at(-1).response;
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(final.id, "native-response");
  assert.equal(final.output[1].namespace, "functions");
  assert.equal(final.output[1].input, "text(42)");
  assert.equal(final.output[1].call_id, "native-call-1");
  assert.ok(
    events.some((x) => x.type === "response.custom_tool_call_input.delta"),
  );
  assert.deepEqual(final.usage, {
    input_tokens: 100,
    output_tokens: 30,
    total_tokens: 130,
    input_tokens_details: { cached_tokens: 7 },
    output_tokens_details: { reasoning_tokens: 10 },
  });
  assert.deepEqual(
    (e.history.restore(final.output[0].encrypted_content) as any).content.parts,
    parts,
  );
  source.input.push(
    ...final.output,
    ...final.output
      .filter((x: any) => x.type === "custom_tool_call")
      .map((x: any, i: number) => ({
        type: "custom_tool_call_output",
        call_id: x.call_id,
        output: String(42 + i),
      })),
  );
  const next = JSON.parse(
    new GeminiEnvelope(model, e.history)
      .request(Buffer.from(JSON.stringify(source)))
      .toString(),
  );
  assert.deepEqual(next.contents[1], { role: "model", parts });
  assert.deepEqual(next.contents[2].parts, [
    {
      functionResponse: {
        id: "native-call-1",
        name,
        response: { output: "42" },
      },
    },
    { functionResponse: { name, response: { output: "43" } } },
  ]);
  const changed = structuredClone(source);
  changed.input.find((x: any) => x.type === "custom_tool_call").input =
    "text(99)";
  assert.throws(
    () =>
      new GeminiEnvelope(model, e.history).request(
        Buffer.from(JSON.stringify(changed)),
      ),
    /differs/,
  );
});
test("Gemini exact text mirrors and inline images survive round-trip without synthetic signatures", async () => {
  const { e, source } = envelope();
  const p = [
    { text: "Hello " },
    { text: "world €" },
    { text: "", thoughtSignature: "tail-signature" },
  ];
  const f = (await convert(geminiFrames("text-id", p), e)).at(-1).response;
  source.input.push(...f.output, {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_image",
        image_url: "data:image/png;base64,AAAA",
        detail: "auto",
      },
    ],
  });
  const w = JSON.parse(
    new GeminiEnvelope(model, e.history)
      .request(Buffer.from(JSON.stringify(source)))
      .toString(),
  );
  assert.deepEqual(w.contents[1].parts, p);
  assert.deepEqual(w.contents[2].parts, [
    { inlineData: { mimeType: "image/png", data: "AAAA" } },
  ]);
});
test("Gemini retains larger catalogs and validates the original structured-output schema", async () => {
  const source = request();
  source.tools = Array.from({ length: 160 }, (_, i) => ({
    type: "function",
    name: `tool_${i}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  }));
  const e = new GeminiEnvelope(model, history());
  const wire = JSON.parse(
    e.request(Buffer.from(JSON.stringify(source))).toString(),
  );
  assert.equal(wire.tools[0].functionDeclarations.length, 160);
  assert.equal(e.tools.counts.rejected, 0);
  for (const [text, ok] of [
    [JSON.stringify({ answer: 42 }), true],
    [JSON.stringify({ answer: "wrong" }), false],
    ["not-json", false],
  ] as const) {
    const body = request();
    body.tools = [];
    body.text = {
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
    const env = new GeminiEnvelope(model, history());
    env.request(Buffer.from(JSON.stringify(body)));
    const result = convert(geminiFrames("json-output", [{ text }]), env);
    if (ok) assert.equal((await result).at(-1).type, "response.completed");
    else await assert.rejects(result, /contract|schema/);
  }
});
test("Gemini unknown/unmapped requests and original schema violations fail explicitly", async () => {
  for (const mutate of [
    (x: any) => (x.unknown = true),
    (x: any) => (x.reasoning = { effort: "high" }),
    (x: any) => (x.previous_response_id = "other"),
    (x: any) => (x.parallel_tool_calls = false),
    (x: any) =>
      x.input.push({ type: "reasoning", encrypted_content: "foreign" }),
    (x: any) =>
      x.input.push({ type: "message", role: "developer", content: "late" }),
    (x: any) => (x.max_output_tokens = 32769),
  ]) {
    const source = request();
    mutate(source);
    assert.throws(
      () =>
        new GeminiEnvelope(model, history()).request(
          Buffer.from(JSON.stringify(source)),
        ),
      (x) => (x as any).code === "GEMINI_COMPATIBILITY",
    );
  }
  const { e, wire } = envelope();
  await assert.rejects(
    convert(
      geminiFrames("bad-schema", [
        {
          functionCall: {
            name: wire.tools[0].functionDeclarations[0].name,
            args: { input: 42 },
          },
        },
      ]),
      e,
    ),
    /schema/,
  );
  const { e: unknown } = envelope();
  await assert.rejects(
    convert(
      geminiFrames("unknown-tool", [
        { functionCall: { name: "bash", args: {} } },
      ]),
      unknown,
    ),
    /catalog/,
  );
});
test("Gemini malformed/truncated/mixed identities do not become successful completions", async () => {
  for (const mutate of [
    (x: any[]) => x.slice(0, -1),
    (x: any[]) => [...x, { responseId: "other-id" }],
    (x: any[]) => [...x, x[0]],
    (x: any[]) => x.map((v: any) => ({ ...v, candidates: [{ index: 1 }] })),
  ]) {
    const { e } = envelope();
    await assert.rejects(
      convert(mutate(geminiFrames("original", [{ text: "hello" }])), e),
    );
  }
  for (const [reason, type] of [
    ["MAX_TOKENS", "response.incomplete"],
    ["SAFETY", "response.failed"],
    ["MALFORMED_FUNCTION_CALL", "response.failed"],
  ]) {
    const { e } = envelope();
    assert.equal(
      (
        await convert(geminiFrames("reason", [{ text: "partial" }], reason), e)
      ).at(-1).type,
      type,
    );
  }
});
test("Gemini private HTTP keeps API key out of URL/Core, sends first text immediately and cancels deadline work", async (t) => {
  const received: any[] = [];
  let mode = "stream",
    closed = 0;
  let terminalSent = false;
  const s = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    received.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    if (mode === "error") {
      res.writeHead(429);
      res.end("fixture-key overload");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const f = geminiFrames("http-native", [{ text: "Immediate text" }]);
    res.write(geminiSse(f.slice(0, -1)));
    res.once("close", () => closed++);
    if (mode === "stream")
      setTimeout(() => {
        terminalSent = true;
        res.end(geminiSse(f.slice(-1)));
      }, 150);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  );
  const b = await geminiBridge({
    endpoint: `http://127.0.0.1:${(s.address() as any).port}/v1beta`,
    token: "fixture-key",
    model,
    history: history(),
    deadlineMs: 400,
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
  let output = "";
  while (!output.includes("response.output_text.delta")) {
    const x = await reader.read();
    assert.equal(x.done, false);
    output += new TextDecoder().decode(x.value);
  }
  assert.equal(terminalSent, false);
  assert.doesNotMatch(output, /response.completed/);
  for (;;) {
    const x = await reader.read();
    if (x.done) break;
    output += new TextDecoder().decode(x.value);
  }
  assert.match(output, /response.completed/);
  assert.equal(
    received[0].url,
    `/v1beta/models/${model.id}:streamGenerateContent?alt=sse`,
  );
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(received[0].headers["x-goog-api-key"], "fixture-key");
  assert.equal(received[0].headers[PROVIDER_TOKEN_HEADER], undefined);
  mode = "error";
  const err = await fetch(`${b.endpoint}/responses`, opts);
  assert.equal(err.status, 429);
  assert.doesNotMatch(await err.text(), /fixture-key/);
  mode = "hold";
  const hold = await fetch(`${b.endpoint}/responses`, opts);
  await assert.rejects(hold.text());
  assert.ok(closed >= 2);
});
