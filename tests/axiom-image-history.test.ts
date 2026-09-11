import test from "node:test";
import assert from "node:assert/strict";
import { contextBody } from "../src/engine/axiom-context-bridge";

const encode = (source: string) =>
  contextBody(Buffer.from(source), 262144, "fixture");
const image =
  '{"type":"message","role":"user","content":[{"type":"input_text","text":"What is in this image?"},{"type":"input_image","image_url":"data:image/png;base64,QAONLY=="}]}';

test("Axiom image history accepts prior assistant output_text without altering roles, IDs, tools or payload bytes", () => {
  const source = ` \n{"model":"fixture", "context_window":262144,"input":[
    {"type":"message","id":"assistant-1","role":"assistant","content":[{"type":"output_text","text":"Città 🛰️ \\"type\\":\\"output_text\\"","annotations":[],"logprobs":[1e-3]}]},
    {"type":"function_call","id":"tool-1","call_id":"call-1","name":"output_text","arguments":"{\\"n\\":9007199254740993}"},
    {"type":"function_call_output","call_id":"call-1","output":{"role":"assistant","content":[{"type":"output_text","text":"untouched tool data"}],"n":9007199254740993}},
    ${image}],"metadata":{"type":"output_text","number":9007199254740993,"negative":-0,"exp":1e3}} \n`;
  const expected = source.replace(
    '"type":"output_text","text":"Città',
    '"type":"input_text","text":"Città',
  );
  assert.equal(encode(source).toString(), expected);
  const parsed = JSON.parse(expected);
  assert.equal(parsed.input[0].role, "assistant");
  assert.equal(parsed.input[2].output.content[0].type, "output_text");
  const once = encode(source);
  assert.equal(
    contextBody(once, 262144, "fixture"),
    once,
    "idempotent with no extra allocation",
  );
});

test("Mapping is restricted to assistant message content in an actual image history", () => {
  for (const input of [
    [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "text only" }],
      },
    ],
    [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "text only" }],
      },
      { type: "function_call_output", output: JSON.parse(image) },
    ],
    [
      JSON.parse(image),
      {
        role: "user",
        content: [{ type: "output_text", text: "not assistant" }],
      },
    ],
    [
      JSON.parse(image),
      {
        type: "function_call_output",
        role: "assistant",
        content: [{ type: "output_text", text: "tool" }],
      },
    ],
    [
      JSON.parse(image),
      {
        role: "assistant",
        content: [
          { type: "refusal", refusal: "unchanged" },
          { type: "output_text", text: 1 },
        ],
      },
    ],
    [JSON.parse(image), { role: "assistant", content: "string preserved" }],
  ]) {
    const raw = Buffer.from(
      JSON.stringify({ model: "fixture", context_window: 262144, input }),
    );
    assert.equal(contextBody(raw, 262144, "fixture"), raw);
  }
});

test("Escaped keys/discriminators, reordered fields, multiple parts and context insertion preserve original spellings", () => {
  const source = `{"model":"fixture","in\\u0070ut":[${image},{"content":[{"text":"a","ty\\u0070e":"out\\u0070ut_text"},{"text":"b","type":"output_text"}],"role":"assistant"}]}`;
  assert.equal(
    encode(source).toString(),
    source
      .replace("{", '{"context_window":262144,')
      .replace('"out\\u0070ut_text"', '"input_text"')
      .replace('"output_text"', '"input_text"'),
  );
});

test("Large images and deeply nested tool payloads are navigated without recursive stack growth", () => {
  const deep = "[".repeat(12000) + "9007199254740993" + "]".repeat(12000);
  const source = `{"model":"fixture","context_window":262144,"input":[{"type":"function_call_output","output":${deep}},${image.replace("QAONLY==", "A".repeat(1024 * 1024))},{"role":"assistant","content":[{"type":"output_text","text":"after image"}]}]}`;
  assert.equal(
    encode(source).toString(),
    source.replace('"output_text"', '"input_text"'),
  );
});
