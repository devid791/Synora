import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  responsesBridge,
  PROVIDER_TOKEN_HEADER,
} from "../src/engine/responses-provider";
import { ResponsesToolCodec } from "../src/engine/responses-tool-codec";
const envelope = () => ({
  tools: new ResponsesToolCodec(),
  metadata: [],
  request: (b: Buffer) => b,
});
test("optional anonymous provider keeps private Core capability and does not downgrade keyed providers", async (t) => {
  let upstreamCalls = 0;
  const server = createServer((req, res) => {
    upstreamCalls++;
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const response = { id: "anonymous-owned", status: "completed", output: [] };
    res.end(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
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
  const options = {
    endpoint,
    token: "",
    label: "Controlled compatible",
    errorPrefix: "COMPATIBLE",
    envelope,
  };
  await assert.rejects(() => responsesBridge(options), /raw Bearer token/);
  // Even explicit anonymous eligibility never permits sending a real key over
  // remote plaintext. Validation happens before any network request.
  await assert.rejects(
    () =>
      responsesBridge({
        ...options,
        endpoint: "http://192.0.2.10/v1",
        token: "fixture-secret",
        allowAnonymous: true,
      }),
    /HTTPS/,
  );
  const bridge = await responsesBridge({ ...options, allowAnonymous: true });
  t.after(() => bridge.close());
  const forbidden = await fetch(`${bridge.endpoint}/responses`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(forbidden.status, 403);
  await forbidden.text();
  assert.equal(upstreamCalls, 0);
  const accepted = await fetch(`${bridge.endpoint}/responses`, {
    method: "POST",
    headers: { [PROVIDER_TOKEN_HEADER]: bridge.token },
    body: "{}",
  });
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /response.completed/);
  assert.equal(upstreamCalls, 1);
});
