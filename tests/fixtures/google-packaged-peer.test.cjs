const test = require("node:test");
const assert = require("node:assert/strict");
const { createPeerDispatcher } = require("./google-packaged-peer.cjs");

test("QA peer changes only exact token/revoke POST origin; preserves handler and transport fields", () => {
  const forwarded = [],
    controlled = [],
    requests = [];
  const previous = {
    dispatch: (options, handler) => {
      forwarded.push({ options, handler });
      return false;
    },
  };
  const peer = {
    dispatch: (options, handler) => {
      controlled.push({ options, handler });
      return true;
    },
  };
  const dispatcher = createPeerDispatcher(
    "http://127.0.0.1:12345",
    previous,
    peer,
    requests,
  );
  const handler = {},
    body = Buffer.from("qa-only"),
    headers = ["content-type", "application/x-www-form-urlencoded"];
  for (const route of ["/token", "/revoke"]) {
    const options = {
      origin: "https://oauth2.googleapis.com",
      path: route,
      method: "POST",
      body,
      headers,
    };
    assert.equal(dispatcher.dispatch(options, handler), true);
    assert.equal(options.origin, "https://oauth2.googleapis.com");
    assert.deepEqual(controlled.at(-1), {
      options: { ...options, origin: "http://127.0.0.1:12345" },
      handler,
    });
    assert.equal(controlled.at(-1).options.body, body);
    assert.equal(controlled.at(-1).options.headers, headers);
    assert.equal(controlled.at(-1).handler, handler);
  }
  for (const partial of [
    { origin: "https://oauth2.googleapis.com.evil.invalid" },
    { origin: "http://oauth2.googleapis.com" },
    { origin: "https://oauth2.googleapis.com:8443" },
    { path: "/token?extra=1" },
    { path: "/token/" },
    { path: "/other" },
    { method: "GET" },
    { query: { extra: "1" } },
  ]) {
    const options = {
      origin: "https://oauth2.googleapis.com",
      path: "/token",
      method: "POST",
      body,
      headers,
      ...partial,
    };
    assert.equal(dispatcher.dispatch(options, handler), false);
    assert.equal(forwarded.at(-1).options, options);
    assert.equal(forwarded.at(-1).handler, handler);
  }
  assert.equal(controlled.length, 2);
  assert.equal(forwarded.length, 8);
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests).includes("qa-only"), false);
});

test("QA peer rejects non-loopback or ambiguous physical endpoints", () => {
  for (const endpoint of [
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1",
    "http://127.0.0.1:1234/token",
    "http://qa@127.0.0.1:1234",
    "http://127.0.0.1:1234/?x=1",
  ]) {
    assert.throws(() => createPeerDispatcher(endpoint, {}, {}, []));
  }
});
