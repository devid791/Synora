import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setImmediate as nextTick } from "node:timers/promises";
import {
  compatibleBridge,
  compatibleEndpoint,
  compatibleModels,
  compatibleSettingsSchema,
  CompatibleEnvelope,
  prepareCompatibleProcess,
  validateCompatibleSelection,
  type CompatibleModelOverride,
  type CompatibleSettings,
} from "../src/engine/compatible-provider";
import {
  PROVIDER_TOKEN_HEADER,
  responsesBridge,
} from "../src/engine/responses-provider";
import type { ModelCapabilities } from "../src/shared/contracts";

const caps: CompatibleModelOverride = {
  contextWindow: 123456,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "high",
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  tools: true,
  supportedParameters: [
    "parallel_tool_calls",
    "prompt_cache_key",
    "max_output_tokens",
    "temperature",
    "top_p",
    "text.format",
    "text.verbosity",
    "reasoning.summary",
    "reasoning.encrypted_content",
  ],
};
const model: ModelCapabilities = {
  id: "operator/team/model-v42",
  context_window: caps.contextWindow!,
  context_window_options: [],
  reasoning_efforts: caps.reasoningEfforts!,
  default_reasoning_effort: "high",
  providerModel: {
    provider: "compatible",
    aliases: [],
    inputModalities: caps.inputModalities!,
    description:
      "Controlled fixture capability assertions, not public inference",
    compatible: caps,
  },
};
const settings: CompatibleSettings = {
  protocol: "responses",
  modelOverrides: { [model.id]: caps },
};
const request = (): any => ({
  model: model.id,
  stream: true,
  store: false,
  instructions: "Original instructions",
  input: [
    {
      type: "message",
      id: "developer-1",
      role: "developer",
      content: "Original workspace instructions",
      internal_chat_message_metadata_passthrough: { owner: "Core" },
    },
    { role: "user", content: "Read the file" },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      tools: [
        {
          type: "custom",
          name: "exec",
          description: "Original command executor",
        },
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
  include: ["reasoning.encrypted_content"],
  client_metadata: { session_id: "original-session" },
  session_id: "original-session",
  prompt_cache_key: "original-prefix",
});
function prepare(source = request(), selected = model) {
  const envelope = new CompatibleEnvelope(selected);
  return {
    envelope,
    wire: JSON.parse(
      envelope.request(Buffer.from(JSON.stringify(source))).toString(),
    ),
  };
}
async function fixture(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const errors: unknown[] = [];
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        errors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end("Controlled fixture assertion failed");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    assert.deepEqual(errors, [], "Controlled HTTP handler must not fail");
  });
  return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/prefix/v1`;
}
async function jsonBody(req: IncomingMessage) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
const sse = (event: any) =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
function events(text: string): any[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim();
    return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
  });
}
async function post(
  bridge: Awaited<ReturnType<typeof compatibleBridge>>,
  source = request(),
  signal?: AbortSignal,
) {
  return fetch(`${bridge.endpoint}/responses`, {
    method: "POST",
    headers: {
      [PROVIDER_TOKEN_HEADER]: bridge.token,
      "content-type": "application/json",
      authorization: "Bearer forbidden-Core-token",
      cookie: "private-Core-cookie",
    },
    body: JSON.stringify(source),
    signal,
  });
}

test("compatible settings require explicit Responses, reject fake protocols/credentials and validate partial overrides", () => {
  assert.deepEqual(compatibleSettingsSchema.parse({ protocol: "responses" }), {
    protocol: "responses",
  });
  assert.deepEqual(compatibleSettingsSchema.parse(settings), settings);
  for (const bad of [
    undefined,
    {},
    { protocol: "chat" },
    { protocol: "chat-completions" },
    { protocol: "responses", apiKey: "secret" },
    { protocol: "responses", modelOverrides: { x: { contextWindow: 0 } } },
    {
      protocol: "responses",
      modelOverrides: { x: { reasoningEfforts: ["high", "high"] } },
    },
    {
      protocol: "responses",
      modelOverrides: {
        x: { reasoningEfforts: [], defaultReasoningEffort: "high" },
      },
    },
    { protocol: "responses", modelOverrides: { x: { hostedTools: true } } },
  ])
    assert.equal(compatibleSettingsSchema.safeParse(bad).success, false);
  assert.equal(
    compatibleSettingsSchema.safeParse({
      protocol: "responses",
      modelOverrides: {
        x: { reasoningEfforts: [], defaultReasoningEffort: null, tools: true },
      },
    }).success,
    true,
  );
});

test("compatible endpoint accepts arbitrary HTTPS base paths and literal local/private HTTP, never unsafe URLs", () => {
  for (const url of [
    "https://custom.example/v8",
    "https://custom.example:8443/prefix/v1",
    "http://localhost:1000",
    "http://127.0.0.1/v1",
    "http://10.2.3.4/v1",
    "http://172.16.0.2/v1",
    "http://172.31.255.254/v1",
    "http://192.168.1.23/v1",
    "http://169.254.2.3/v1",
    "http://[::1]:8000/v1",
    "http://[fd12::1]/v1",
    "http://[fe80::1]/v1",
    "http://[::ffff:192.168.1.2]/v1",
  ])
    assert.equal(
      compatibleEndpoint(`${url}/`),
      new URL(url).href.replace(/\/$/, ""),
    );
  for (const url of [
    "http://public.example/v1",
    "http://8.8.8.8/v1",
    "http://172.32.0.1/v1",
    "http://192.169.1.1/v1",
    "http://[2001:4860:4860::8888]/v1",
    "http://[::ffff:8.8.8.8]/v1",
    "https://u:p@example.com/v1",
    "https://@example.com/v1",
    "https://example.com?token=x",
    "https://example.com?",
    "https://example.com#",
    "https://example.com/#fragment",
    "ftp://localhost/v1",
    "https://example.com\\evil",
    " https://example.com",
    "https://example.com/\n",
    "http://0.0.0.0/v1",
  ])
    assert.throws(() => compatibleEndpoint(url), /HTTPS API base URL/);
});

test("ID-only /models stays visible and unavailable; manual capabilities only supplement exact returned identities with auth none", async (t) => {
  const endpoint = await fixture(t, (req, res) => {
    assert.equal(req.url, "/prefix/v1/models");
    assert.equal(req.headers.authorization, undefined);
    res.end(
      JSON.stringify({ data: [{ id: model.id }, { id: "future-unknown" }] }),
    );
  });
  await assert.rejects(
    () => compatibleModels(endpoint),
    /Select the Responses protocol/,
  );
  const unknown = await compatibleModels(endpoint, undefined, {
    protocol: "responses",
  });
  assert.equal(unknown[0].context_window, null);
  assert.deepEqual(unknown[0].reasoning_efforts, []);
  assert.deepEqual(unknown[0].providerModel?.inputModalities, []);
  for (const field of [
    "contextWindow",
    "reasoningEfforts",
    "inputModalities",
    "outputModalities",
    "tools",
  ])
    assert.match(unknown[0].unavailableReason!, new RegExp(`missing ${field}`));
  const supplemented = await compatibleModels(endpoint, "", {
    ...settings,
    modelOverrides: { ...settings.modelOverrides, absent: caps },
  });
  assert.deepEqual(
    supplemented.map((m) => m.id),
    [model.id, "future-unknown"],
  );
  assert.equal(supplemented[0].context_window, 123456);
  assert.equal(supplemented[0].unavailableReason, undefined);
  assert.deepEqual(supplemented[0].providerModel?.compatible, caps);
  assert.match(
    supplemented[0].providerModel!.description,
    /operator capabilities/,
  );
  assert.match(supplemented[0].providerModel!.description, /plaintext/);
  assert.equal(
    validateCompatibleSelection(supplemented, model.id, "high"),
    supplemented[0],
  );
  assert.throws(
    () => validateCompatibleSelection(supplemented, "absent"),
    /cannot fabricate/,
  );
  assert.throws(
    () => validateCompatibleSelection(supplemented, "future-unknown"),
    /Configure modelOverrides/,
  );
  assert.throws(
    () => validateCompatibleSelection(supplemented, model.id, "xhigh"),
    /not declared/,
  );
});

test("catalog metadata and partial operator overrides merge without inventing reasoning or defaults", async (t) => {
  const endpoint = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: model.id,
            context_window: 9000,
            reasoning_efforts: [],
            input_modalities: ["text"],
            output_modalities: ["text"],
            supported_parameters: ["tools", "parallel_tool_calls"],
          },
          { id: "extension", capabilities: caps },
          {
            id: "invalid-metadata",
            capabilities: { ...caps, contextWindow: "guessed" },
          },
        ],
      }),
    );
  });
  const models = await compatibleModels(endpoint, "fixture-key", {
    protocol: "responses",
    modelOverrides: { [model.id]: { contextWindow: 12000 } },
  });
  assert.equal(models[0].context_window, 12000);
  assert.deepEqual(models[0].reasoning_efforts, []);
  assert.equal(models[0].default_reasoning_effort, undefined);
  assert.equal(models[0].unavailableReason, undefined);
  assert.deepEqual(models[0].providerModel?.compatible?.supportedParameters, [
    "tools",
    "parallel_tool_calls",
  ]);
  assert.equal(models[1].context_window, caps.contextWindow);
  assert.equal(models[1].unavailableReason, undefined);
  assert.match(models[2].unavailableReason!, /invalid contextWindow/);
  const repaired = await compatibleModels(endpoint, "fixture-key", {
    protocol: "responses",
    modelOverrides: { "invalid-metadata": { contextWindow: 42 } },
  });
  assert.equal(repaired[2].unavailableReason, undefined);
  assert.equal(repaired[2].context_window, 42);
});

test("catalog rejects duplicate IDs, malformed identities, hidden pagination and retains disabled capabilities", async (t) => {
  let catalog: any = { data: [{ id: "duplicate" }, { id: "duplicate" }] };
  const endpoint = await fixture(t, (_req, res) => {
    res.end(JSON.stringify(catalog));
  });
  await assert.rejects(
    () => compatibleModels(endpoint, "", settings),
    /duplicate/,
  );
  catalog = { data: [{ id: "" }] };
  await assert.rejects(() => compatibleModels(endpoint, "", settings));
  for (const pagination of [
    { has_more: true },
    { links: { next: "https://other.invalid/models" } },
  ]) {
    catalog = { data: [{ id: model.id }], ...pagination };
    await assert.rejects(
      () => compatibleModels(endpoint, "", settings),
      /paginated/,
    );
  }
  catalog = {
    data: [
      {
        id: model.id,
        capabilities: {
          ...caps,
          tools: false,
          inputModalities: ["audio"],
          outputModalities: ["image"],
        },
      },
    ],
  };
  const [disabled] = await compatibleModels(endpoint, "", {
    protocol: "responses",
  });
  assert.equal(disabled.id, model.id);
  assert.match(disabled.unavailableReason!, /function calling/);
  assert.match(disabled.unavailableReason!, /text input/);
  assert.match(disabled.unavailableReason!, /text output/);
});

test("private HTTP accepts anonymous catalog but rejects bearer before any network; HTTPS/loopback credentials stay validated", async (t) => {
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls++;
      assert.equal(url, "http://10.3.2.1/v1/models");
      assert.deepEqual(options.headers, {});
      assert.equal(options.redirect, "error");
      return new Response(JSON.stringify({ data: [{ id: model.id }] }));
    },
  );
  assert.equal(
    (await compatibleModels("http://10.3.2.1/v1", "", settings))[0]
      .unavailableReason,
    undefined,
  );
  await assert.rejects(
    () => compatibleModels("http://10.3.2.1/v1", "private-key", settings),
    /remote plaintext HTTP/,
  );
  assert.throws(
    () =>
      compatibleBridge({
        endpoint: "http://10.3.2.1/v1",
        token: "private-key",
        model,
      }),
    /remote plaintext HTTP/,
  );
  await assert.rejects(
    () =>
      compatibleModels("https://example.invalid/v1", "Bearer bad", settings),
    /raw Bearer/,
  );
  assert.equal(calls, 1, "No real private/public endpoint was contacted");
});

test("anonymous process preparation opts in and reaches catalog validation before touching Core or state", async (t) => {
  let calls = 0;
  const endpoint = await fixture(t, (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ data: [{ id: "unknown" }] }));
  });
  await assert.rejects(
    () =>
      prepareCompatibleProcess(
        {
          endpoint,
          model: "unknown",
          profile: "",
          context: null,
          cwd: "/home/synora/Synora_Harness_Desktop",
          stateDirectory:
            "/home/synora/Synora_Harness_Desktop/out/compatible-must-not-create",
        },
        { protocol: "responses" },
      ),
    /Configure modelOverrides/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    () =>
      responsesBridge({
        endpoint,
        token: "",
        label: "Non opted-in peer",
        errorPrefix: "PEER",
        envelope: () => new CompatibleEnvelope(model),
      }),
    /raw Bearer/,
  );
});

test("envelope retains full history, original roles, reasoning, signatures, schemas and host-only metadata", () => {
  const source = request();
  source.input.push(
    {
      type: "reasoning",
      id: "reason-1",
      summary: [],
      content: [{ type: "reasoning_text", text: "Original reasoning" }],
      encrypted_content: "opaque-original",
      signature: "original-signature",
    },
    {
      type: "custom_tool_call",
      id: "item-a",
      call_id: "call-a",
      namespace: "functions",
      name: "exec",
      input: 'text("héllo 🚀")',
    },
    {
      type: "custom_tool_call_output",
      id: "result-a",
      call_id: "call-a",
      output: "Original result bytes\n",
    },
    {
      role: "assistant",
      phase: "commentary",
      content: [
        { type: "output_text", text: "Original message", annotations: [] },
      ],
    },
  );
  source.tool_choice = { type: "custom", namespace: "functions", name: "exec" };
  const original = structuredClone(source);
  const { envelope, wire } = prepare(source);
  assert.deepEqual(source, original);
  assert.equal(wire.input[0].role, "developer");
  assert.equal(wire.input[0].id, "developer-1");
  assert.deepEqual(wire.input[2], original.input[2]);
  assert.equal(wire.input[3].call_id, "call-a");
  assert.equal(wire.input[3].id, "item-a");
  assert.deepEqual(JSON.parse(wire.input[3].arguments), {
    input: original.input[3].input,
  });
  assert.equal(wire.input[4].type, "function_call_output");
  assert.equal(wire.input[4].output, "Original result bytes\n");
  assert.equal(wire.input[4].id, "result-a");
  assert.deepEqual(wire.input[5], original.input[5]);
  assert.deepEqual(
    wire.tools[1].parameters,
    original.tools[0].tools[1].parameters,
  );
  assert.equal(wire.tools[1].strict, true);
  assert.equal(wire.tool_choice.name, wire.tools[0].name);
  assert.equal(wire.provider, undefined, "No OpenRouter provider field");
  assert.equal(wire.client_metadata, undefined);
  assert.equal(wire.session_id, undefined);
  assert.equal(wire.prompt_cache_key, original.prompt_cache_key);
  assert.deepEqual(
    envelope.metadata.map((entry) => entry.path),
    [
      "$.client_metadata",
      "$.session_id",
      "$.input[0].internal_chat_message_metadata_passthrough",
    ],
  );
  assert.deepEqual(envelope.tools.counts, {
    advertised: 2,
    translated: 2,
    rejected: 0,
  });
});

test("envelope preserves declared images including tool results, without fetching local/remote image URLs", () => {
  const source = request();
  const image = {
    type: "input_image",
    image_url: "data:image/png;base64,aGk=",
    detail: "low",
  };
  source.input[1].content = [image];
  source.input.push(
    {
      type: "function_call",
      id: "i",
      call_id: "c",
      namespace: "functions",
      name: "read_file",
      arguments: '{"path":"a"}',
    },
    { type: "function_call_output", call_id: "c", output: [image] },
  );
  const { wire } = prepare(source);
  assert.deepEqual(wire.input[1].content, [image]);
  assert.deepEqual(wire.input.at(-1).output, [image]);
});

test("explicit non-reasoning model works without guessed effort or optional parameters", () => {
  const selected = structuredClone(model);
  selected.reasoning_efforts = [];
  delete selected.default_reasoning_effort;
  selected.providerModel!.compatible!.reasoningEfforts = [];
  selected.providerModel!.compatible!.defaultReasoningEffort = null;
  delete selected.providerModel!.compatible!.supportedParameters;
  const source = {
    model: model.id,
    stream: true,
    store: false,
    input: [{ role: "user", content: "Plain request" }],
    tools: [],
  };
  assert.deepEqual(prepare(source, selected).wire, source);
});

test("shared tool catalog markers remain reversible and no provider tool ceiling is invented", () => {
  const source = request();
  const marker = {
    type: "additional_tools",
    id: "catalog-original",
    role: "developer",
    tools: source.tools,
  };
  source.input.push(marker);
  source.tools = Array.from({ length: 129 }, (_, i) => ({
    type: "function",
    name: `tool_${i}`,
    parameters: { type: "object", properties: {} },
  }));
  const { envelope, wire } = prepare(source);
  assert.equal(wire.tools.length, 131);
  assert.equal(envelope.tools.counts.advertised, 131);
  assert.equal(wire.input.length, 2);
  assert.deepEqual(envelope.tools.catalogItems, [marker]);
});

test("unsupported hosted features, malformed history and undeclared parameters are explicit errors, never silently dropped", () => {
  const mutations: [string, (source: any) => void][] = [
    [
      "foreign provider routing",
      (r) => (r.provider = { require_parameters: true }),
    ],
    ["hosted web search", (r) => r.tools.push({ type: "web_search" })],
    ["hosted include", (r) => r.include.push("file_search_call.results")],
    [
      "hosted image file",
      (r) =>
        (r.input[1].content = [{ type: "input_image", file_id: "file-1" }]),
    ],
    ["foreign previous response", (r) => (r.previous_response_id = "other")],
    ["storage", (r) => (r.store = true)],
    ["nonstream", (r) => (r.stream = false)],
    ["truncation", (r) => (r.truncation = "auto")],
    ["background", (r) => (r.background = true)],
    ["missing full history", (r) => (r.input = "Summary")],
    ["unsupported role", (r) => (r.input[0].role = "tool")],
    [
      "unsupported content",
      (r) => (r.input[1].content = [{ type: "input_audio", data: "hidden" }]),
    ],
    [
      "unsupported history item",
      (r) => r.input.push({ type: "item_reference", id: "other" }),
    ],
    [
      "orphan result",
      (r) =>
        r.input.push({
          type: "function_call_output",
          call_id: "missing",
          output: "result",
        }),
    ],
    [
      "missing result",
      (r) =>
        r.input.push({
          type: "function_call",
          call_id: "c",
          name: "read_file",
          namespace: "functions",
          arguments: "{}",
        }),
    ],
    ["unknown effort", (r) => (r.reasoning.effort = "xhigh")],
    ["undeclared parameter", (r) => (r.user = "not-declared")],
    ["foreign model", (r) => (r.model = "unselected")],
  ];
  for (const [label, mutate] of mutations) {
    const source = request();
    mutate(source);
    assert.throws(() => prepare(source), { name: /Error/ }, label);
  }
  const reduced = structuredClone(model);
  reduced.providerModel!.compatible!.supportedParameters = [];
  assert.throws(
    () => prepare(request(), reduced),
    /parallel_tool_calls.*not declared/,
  );
  assert.throws(
    () => new CompatibleEnvelope({ ...model, context_window: 999 }),
    /differs from/,
  );
  assert.throws(
    () => new CompatibleEnvelope(model).request(Buffer.from([0xff])),
    /UTF-8 JSON/,
  );
});

test("real HTTP Responses SSE and two-turn parallel custom/function tool roundtrip preserve call IDs with anonymous and bearer auth", async (t) => {
  for (const token of ["", "fixture-key"])
    await t.test(token ? "bearer" : "anonymous", async (t) => {
      const received: any[] = [];
      const reasoning = {
        type: "reasoning",
        id: "reason-original",
        summary: [],
        content: [{ type: "reasoning_text", text: "Original reasoning" }],
        encrypted_content: "original-opaque",
      };
      const input = 'text("héllo 🚀\\n")';
      const endpoint = await fixture(t, async (req, res) => {
        assert.equal(
          req.headers.authorization,
          token ? `Bearer ${token}` : undefined,
        );
        assert.equal(req.headers.cookie, undefined);
        assert.equal(req.headers[PROVIDER_TOKEN_HEADER], undefined);
        if (req.url === "/prefix/v1/models") {
          res.end(JSON.stringify({ data: [{ id: model.id }] }));
          return;
        }
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/prefix/v1/responses");
        const wire = await jsonBody(req);
        received.push(wire);
        assert.equal(wire.provider, undefined);
        assert.equal(wire.input[0].role, "developer");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const output =
          received.length === 1
            ? [
                reasoning,
                {
                  type: "function_call",
                  id: "item-a",
                  call_id: "call-a",
                  name: wire.tools[0].name,
                  arguments: JSON.stringify({ input }),
                },
                {
                  type: "function_call",
                  id: "item-b",
                  call_id: "call-b",
                  name: wire.tools[1].name,
                  arguments: '{"path":"a.txt"}',
                },
              ]
            : [
                {
                  type: "message",
                  id: "message-final",
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "Roundtrip complete" },
                  ],
                },
              ];
        const frames: any[] = [
          {
            type: "response.created",
            response: {
              id: `response-${received.length}`,
              status: "in_progress",
            },
          },
        ];
        for (const [i, item] of output.entries()) {
          frames.push({
            type: "response.output_item.added",
            output_index: i,
            item:
              item.type === "function_call" ? { ...item, arguments: "" } : item,
          });
          if (item.type === "function_call" && "arguments" in item) {
            for (let j = 0; j < item.arguments.length; j += 3)
              frames.push({
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: i,
                delta: item.arguments.slice(j, j + 3),
              });
            frames.push({
              type: "response.function_call_arguments.done",
              item_id: item.id,
              output_index: i,
              arguments: item.arguments,
            });
          }
          frames.push({
            type: "response.output_item.done",
            output_index: i,
            item,
          });
        }
        frames.push({
          type: "response.completed",
          response: {
            id: `response-${received.length}`,
            status: "completed",
            output,
          },
        });
        const bytes = Buffer.from(
          `: controlled fixture\n\n${frames.map((frame) => `id: event-original\n${sse(frame)}`).join("")}data: [DONE]\n\n`,
        );
        for (let i = 0; i < bytes.length; i += 7) {
          res.write(bytes.subarray(i, i + 7));
          await nextTick();
        }
        res.end();
      });
      const [selected] = await compatibleModels(endpoint, token, settings);
      const bridge = await compatibleBridge({
        endpoint,
        token,
        model: selected,
      });
      t.after(() => bridge.close());
      const response = await post(bridge);
      assert.equal(response.status, 200);
      const text = await response.text(),
        stream = events(text);
      assert.match(text, /id: event-original/);
      const output = stream.at(-1).response.output;
      assert.deepEqual(output[0], reasoning);
      assert.equal(output[1].type, "custom_tool_call");
      assert.equal(output[1].namespace, "functions");
      assert.equal(output[1].name, "exec");
      assert.equal(output[1].input, input);
      assert.equal(output[1].call_id, "call-a");
      assert.equal(output[1].id, "item-a");
      assert.equal(output[2].name, "read_file");
      assert.equal(output[2].call_id, "call-b");
      assert.equal(
        stream
          .filter((e) => e.type === "response.custom_tool_call_input.delta")
          .map((e) => e.delta)
          .join(""),
        input,
      );
      const followup = request();
      followup.input.push(
        ...output,
        {
          type: "custom_tool_call_output",
          id: "result-a",
          call_id: "call-a",
          output: "command result\n",
        },
        {
          type: "function_call_output",
          id: "result-b",
          call_id: "call-b",
          output: "file bytes\n",
        },
      );
      const final = await post(bridge, followup);
      assert.equal(
        events(await final.text()).at(-1).response.output[0].content[0].text,
        "Roundtrip complete",
      );
      assert.equal(received.length, 2);
      assert.deepEqual(received[1].input[2], reasoning);
      assert.equal(received[1].input[3].call_id, "call-a");
      assert.equal(received[1].input[3].name, received[0].tools[0].name);
      assert.equal(received[1].input[5].output, "command result\n");
      assert.equal(received[1].input[5].id, "result-a");
      assert.equal(received[1].input[6].call_id, "call-b");
    });
});

test("bridge remains private and surfaces original HTTP errors with credential redaction; redirects never contact another endpoint", async (t) => {
  let targetHits = 0,
    upstreamHits = 0,
    redirect = false;
  const target = await fixture(t, (_req, res) => {
    targetHits++;
    res.end();
  });
  const endpoint = await fixture(t, (_req, res) => {
    upstreamHits++;
    if (redirect) {
      res.writeHead(307, { location: target });
      res.end();
    } else {
      res.writeHead(429);
      res.end("fixture-key: exact upstream quota detail");
    }
  });
  const bridge = await compatibleBridge({
    endpoint,
    token: " fixture-key ",
    model,
  });
  t.after(() => bridge.close());
  const unauthorized = await fetch(`${bridge.endpoint}/responses`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(unauthorized.status, 403);
  await unauthorized.body?.cancel();
  assert.equal(upstreamHits, 0);
  const failed = await post(bridge),
    error = await failed.json();
  assert.equal(failed.status, 429);
  assert.equal(error.error.code, "COMPATIBLE_UPSTREAM");
  assert.match(error.error.message, /exact upstream quota detail/);
  assert.doesNotMatch(error.error.message, /fixture-key/);
  await assert.rejects(
    () => compatibleModels(endpoint, " fixture-key ", settings),
    (e: Error) =>
      /HTTP 429/.test(e.message) &&
      /exact upstream quota detail/.test(e.message) &&
      !/fixture-key/.test(e.message),
  );
  redirect = true;
  const redirected = await post(bridge);
  assert.equal(redirected.status, 502);
  assert.match((await redirected.json()).error.message, /redirect rejected/);
  await assert.rejects(() =>
    compatibleModels(endpoint, "fixture-key", settings),
  );
  assert.equal(targetHits, 0);
});

test("real HTTP stream is incremental, cancellation disconnects upstream, and the same bridge recovers", async (t) => {
  let calls = 0;
  let onClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  const endpoint = await fixture(t, async (req, res) => {
    await jsonBody(req);
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sse({
        type: "response.created",
        response: { id: "stream", status: "in_progress" },
      }),
    );
    res.write(
      sse({
        type: "response.output_text.delta",
        item_id: "msg",
        output_index: 0,
        content_index: 0,
        delta: "incremental-before-completion",
      }),
    );
    if (calls === 1) res.once("close", onClose);
    else
      res.end(
        sse({
          type: "response.completed",
          response: { id: "stream", status: "completed", output: [] },
        }),
      );
  });
  const bridge = await compatibleBridge({ endpoint, model });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const response = await post(bridge, request(), controller.signal);
  const reader = response.body!.getReader();
  let partial = "";
  while (!partial.includes("incremental-before-completion")) {
    const value = await reader.read();
    assert.equal(value.done, false);
    partial += Buffer.from(value.value!).toString();
  }
  assert.doesNotMatch(partial, /response.completed/);
  controller.abort();
  await assert.rejects(() => reader.read());
  await closed;
  const recovered = await post(bridge);
  assert.equal(
    events(await recovered.text()).at(-1).type,
    "response.completed",
  );
  assert.equal(calls, 2);
});

test(
  "upstream deadline aborts pending HTTP and close is idempotent",
  { timeout: 5000 },
  async (t) => {
    let onClose!: () => void;
    const closed = new Promise<void>((resolve) => {
      onClose = resolve;
    });
    const endpoint = await fixture(t, async (req, res) => {
      await jsonBody(req);
      res.once("close", onClose);
    });
    const bridge = await compatibleBridge({ endpoint, model, deadlineMs: 80 });
    t.after(() => bridge.close());
    const response = await post(bridge);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "COMPATIBLE_TRANSPORT");
    await closed;
    await bridge.close();
    await bridge.close();
  },
);

test("real truncated SSE and provider failure are never promoted to completion", async (t) => {
  let failResponse = false;
  const endpoint = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      sse({
        type: "response.created",
        response: { id: "failed", status: "in_progress" },
      }),
    );
    if (failResponse)
      res.write(
        sse({
          type: "response.failed",
          response: {
            id: "failed",
            status: "failed",
            output: [],
            error: {
              code: "operator_failure",
              message: "Actual endpoint error",
            },
          },
        }),
      );
    res.end();
  });
  const bridge = await compatibleBridge({ endpoint, model });
  t.after(() => bridge.close());
  await assert.rejects(async () => (await post(bridge)).text());
  failResponse = true;
  const stream = events(await (await post(bridge)).text());
  assert.equal(stream.at(-1).type, "response.failed");
  assert.equal(stream.at(-1).response.error.message, "Actual endpoint error");
  assert.equal(
    stream.some((e) => e.type === "response.completed"),
    false,
  );
});
