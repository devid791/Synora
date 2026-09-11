import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  axiomContextBridge,
  contextBody,
  CONTEXT_TOKEN_HEADER,
} from "../src/engine/axiom-context-bridge";

async function upstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    endpoint: `http://127.0.0.1:${address.port}/codex/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
const original = Buffer.from(
  ' {"model":"fixture-model","instructions":"retain 🛰️","session_id":"session-7","input":[{"type":"function_call_output","call_id":"call-07","output":"UNCHANGED"}],"tools":[{"type":"function","name":"test_tool","parameters":{"type":"object"}}],"tool_choice":"auto","parallel_tool_calls":true,"metadata":{"turn":"turn-1","number":9007199254740993,"spelling":1e3},"stream":true} \n',
);
const options = (endpoint: string, context = 1048576) => ({
  endpoint,
  context,
  model: "fixture-model",
});
const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

test("Axiom context addition preserves source bytes, IDs, tools, numeric spellings and rejects conflicts", () => {
  for (const count of [262144, 1048576]) {
    const encoded = contextBody(original, count, "fixture-model");
    assert.equal(
      encoded.toString(),
      original.toString().replace("{", `{"context_window":${count},`),
    );
    assert.equal(contextBody(encoded, count, "fixture-model"), encoded);
    assert.throws(
      () =>
        contextBody(
          encoded,
          count === 262144 ? 1048576 : 262144,
          "fixture-model",
        ),
      /differs/,
    );
  }
  for (const alias of [
    "context_window",
    "context_length",
    "max_context",
    "axiom_context_window",
  ])
    assert.throws(
      () =>
        contextBody(
          Buffer.from(`{"model":"fixture-model","${alias}":8}`),
          262144,
          "fixture-model",
        ),
      /differs/,
    );
  for (const data of ["null", "[]", "{", '{"model":"wrong"}'])
    assert.throws(() =>
      contextBody(Buffer.from(data), 262144, "fixture-model"),
    );
  assert.throws(
    () => contextBody(Buffer.from([0xc3, 0x28]), 262144, "fixture-model"),
    /UTF-8/,
  );
});

test("Private bridge forwards SSE before upstream completion, with exact body/header/tool identities", async () => {
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let received: Buffer | undefined,
    headers: IncomingMessage["headers"] | undefined;
  const first = Buffer.from(
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1"}}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"item-1","delta":"città 🛰️"}\n\n',
  );
  const last = Buffer.from(
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"tool-1","call_id":"call-07","delta":"{}"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\ndata: [DONE]\n\n',
  );
  const remote = await upstream((req, res) => {
    void (async () => {
      received = await body(req);
      headers = req.headers;
      assert.equal(req.url, "/codex/v1/responses");
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "request-exact",
        session_id: "session-7",
      });
      // Split UTF-8 mid-codepoint; the adapter must not decode response bytes.
      const split = first.indexOf(Buffer.from("🛰")) + 1;
      res.write(first.subarray(0, split));
      res.write(first.subarray(split));
      await completed;
      res.end(last);
    })().catch((error) => res.destroy(error));
  });
  const bridge = await axiomContextBridge(options(remote.endpoint));
  try {
    const reply = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      headers: {
        [CONTEXT_TOKEN_HEADER]: bridge.token,
        "content-type": "application/json",
        session_id: "session-7",
        "x-codex-turn-metadata": "turn-1",
      },
      body: original,
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("session_id"), "session-7");
    assert.equal(reply.headers.get("x-request-id"), "request-exact");
    const reader = reply.body!.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    while (length < first.length) {
      const event = await reader.read();
      assert(!event.done);
      chunks.push(event.value);
      length += event.value.length;
    }
    assert.deepEqual(
      Buffer.concat(chunks),
      first,
      "Initial deltas must arrive while upstream final output is held",
    );
    assert.deepEqual(received, contextBody(original, 1048576, "fixture-model"));
    assert.equal(
      headers?.[CONTEXT_TOKEN_HEADER],
      undefined,
      "Local capability must not leak to Axiom",
    );
    assert.equal(headers?.session_id, "session-7");
    assert.equal(headers?.["x-codex-turn-metadata"], "turn-1");
    finish();
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      chunks.push(item.value);
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, last]));
  } finally {
    finish();
    await bridge.close();
    await remote.close();
  }
});

test("Context bridge preserves concurrent calls, upstream errors and compaction without rerouting arbitrary paths", async () => {
  const seen: Array<{ path: string; raw: Buffer }> = [];
  const remote = await upstream((req, res) => {
    void (async () => {
      const raw = await body(req);
      seen.push({ path: req.url!, raw });
      res.writeHead(req.url!.endsWith("/compact") ? 422 : 200, {
        "content-type": "application/json",
        "x-original-error": "retained",
      });
      res.end(raw.length ? raw : '{"models":[]}');
    })().catch((error) => res.destroy(error));
  });
  const bridge = await axiomContextBridge(options(remote.endpoint));
  const headers = {
    [CONTEXT_TOKEN_HEADER]: bridge.token,
    "content-type": "application/json",
  };
  try {
    const calls = await Promise.all(
      ["a", "b"].map((id) =>
        fetch(`${bridge.endpoint}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: "fixture-model", call_id: id }),
        }).then((response) => response.json()),
      ),
    );
    assert.deepEqual(
      calls.map((c) => c.call_id),
      ["a", "b"],
    );
    assert.ok(calls.every((c) => c.context_window === 1048576));
    const compact = await fetch(`${bridge.endpoint}/responses/compact`, {
      method: "POST",
      headers,
      body: original,
    });
    assert.equal(compact.status, 422);
    assert.equal(compact.headers.get("x-original-error"), "retained");
    assert.deepEqual(Buffer.from(await compact.arrayBuffer()), original);
    assert.deepEqual(seen.at(-1)?.raw, original);
    assert.deepEqual(
      await fetch(`${bridge.endpoint}/models`, { headers }).then((r) =>
        r.json(),
      ),
      { models: [] },
    );
    const before = seen.length;
    for (const path of [
      "/ops/status",
      "/responses?endpoint=elsewhere",
      "/responses/../admin",
      "/anything",
    ])
      assert.equal(
        (await fetch(`${bridge.endpoint}${path}`, { headers })).status,
        404,
      );
    assert.equal(seen.length, before);
  } finally {
    await bridge.close();
    await remote.close();
  }
});

test("Private bridge denies browser/unauthenticated/malformed requests before upstream work", async () => {
  let hits = 0;
  const remote = await upstream((_req, res) => {
    hits++;
    res.end();
  });
  const bridge = await axiomContextBridge({
    ...options(remote.endpoint),
    maxRequestBytes: 1024,
  });
  try {
    for (const headers of [
      {},
      { [CONTEXT_TOKEN_HEADER]: "incorrect" },
      { [CONTEXT_TOKEN_HEADER]: bridge.token, origin: "http://localhost" },
    ] as Array<Record<string, string>>)
      assert.equal(
        (
          await fetch(`${bridge.endpoint}/responses`, {
            method: "POST",
            headers,
            body: original,
          })
        ).status,
        403,
      );
    for (const [raw, expected, extra] of [
      ["{", 400, {}],
      ["a".repeat(1025), 413, {}],
      [original, 415, { "content-encoding": "zstd" }],
    ] as const) {
      const response = await fetch(`${bridge.endpoint}/responses`, {
        method: "POST",
        headers: { [CONTEXT_TOKEN_HEADER]: bridge.token, ...extra },
        body: raw,
      });
      assert.equal(response.status, expected);
      assert.equal((await response.json()).error.type, "synora_provider_error");
    }
    const wrongHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const call = request(
          `${bridge.endpoint}/models`,
          {
            headers: {
              [CONTEXT_TOKEN_HEADER]: bridge.token,
              host: "evil.example",
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        call.on("error", reject);
        call.end();
      },
    );
    assert.equal(wrongHost, 403);
    assert.equal(hits, 0);
  } finally {
    await bridge.close();
    await remote.close();
  }
});

test("Deadline, disconnect and close cancel only bridge-owned upstream work without synthetic success", async () => {
  let upstreamClosed!: () => void;
  let closed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const remote = await upstream((_req, res) => {
    res.on("close", () => upstreamClosed());
    // No headers or output until the adapter's deadline.
  });
  const bridge = await axiomContextBridge({
    ...options(remote.endpoint),
    deadlineMs: 100,
  });
  const headers = { [CONTEXT_TOKEN_HEADER]: bridge.token };
  try {
    const response = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      headers,
      body: original,
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "UPSTREAM_DEADLINE");
    await closed;
    closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const controller = new AbortController();
    const pending = fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      headers,
      body: original,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(pending, /abort/i);
    await closed;
    await Promise.all([bridge.close(), bridge.close()]);
    await assert.rejects(fetch(`${bridge.endpoint}/models`, { headers }));
  } finally {
    await bridge.close();
    await remote.close();
  }
});

test("Provider redirects cannot send the private Core capability to another origin", async () => {
  let hits = 0;
  const other = await upstream((_req, res) => {
    hits++;
    res.end();
  });
  const remote = await upstream((_req, res) => {
    res.writeHead(307, { location: other.endpoint + "/responses" });
    res.end();
  });
  const bridge = await axiomContextBridge(options(remote.endpoint));
  try {
    const response = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST",
      headers: { [CONTEXT_TOKEN_HEADER]: bridge.token },
      body: original,
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "UPSTREAM_REDIRECT");
    assert.equal(hits, 0);
  } finally {
    await bridge.close();
    await remote.close();
    await other.close();
  }
});

test("Active SSE outlives the first-response deadline with exact bytes, without a total-age cutoff", { timeout: 5000 }, async () => {
  const frames = Array.from({ length: 12 }, (_, i) =>
    `event: response.in_progress\ndata: {"type":"response.in_progress","sequence_number":${i},"response":{"id":"same-response","status":"in_progress"}}\n\n`);
  const end = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"same-response","status":"completed"}}\n\n';
  const remote = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    let index = 0;
    const interval = setInterval(() => {
      if (index < frames.length) res.write(frames[index++]);
      else { clearInterval(interval); res.end(end); }
    }, 40);
    res.once("close", () => clearInterval(interval));
  });
  const bridge = await axiomContextBridge({
    ...options(remote.endpoint), responseStartTimeoutMs: 200, streamIdleTimeoutMs: 350,
  });
  try {
    const started = Date.now();
    const result = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST", headers: { [CONTEXT_TOKEN_HEADER]: bridge.token }, body: original,
    });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), frames.join("") + end);
    assert.ok(Date.now() - started > 400);
  } finally { await bridge.close(); await remote.close(); }
});

test("SSE silence cancels the owned upstream without inventing completion", { timeout: 5000 }, async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const remote = await upstream((_req, res) => {
    res.once("close", markClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: response.in_progress\ndata: {"type":"response.in_progress"}\n\n');
  });
  const bridge = await axiomContextBridge({
    ...options(remote.endpoint), responseStartTimeoutMs: 1000, streamIdleTimeoutMs: 100,
  });
  try {
    const response = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST", headers: { [CONTEXT_TOKEN_HEADER]: bridge.token }, body: original,
    });
    let received = "";
    const reader = response.body!.getReader();
    try {
      await assert.rejects(async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += Buffer.from(value).toString();
        }
      });
    } finally { reader.releaseLock(); }
    assert.match(received, /response.in_progress/);
    assert.doesNotMatch(received, /response.completed|\[DONE\]/);
    await closed;
  } finally { await bridge.close(); await remote.close(); }
});

test("Explicit host deadline still aborts a continuously active SSE stream", { timeout: 5000 }, async () => {
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const remote = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    const interval = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 20);
    res.once("close", () => { clearInterval(interval); markClosed(); });
  });
  const bridge = await axiomContextBridge({
    ...options(remote.endpoint), deadlineMs: 150, streamIdleTimeoutMs: 1000,
  });
  try {
    const response = await fetch(`${bridge.endpoint}/responses`, {
      method: "POST", headers: { [CONTEXT_TOKEN_HEADER]: bridge.token }, body: original,
    });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
    await closed;
  } finally { await bridge.close(); await remote.close(); }
});
