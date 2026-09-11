import test from "node:test";
import assert from "node:assert/strict";
import { reportedReasoning } from "../src/renderer/message-text";

test("A complete leading model think block is partitioned with no lost or changed source characters", () => {
  for (const text of [
    "<think>Reported reasoning.</think>Answer",
    " \n<think>🛰️\nline2</think>\n\nOriginal answer",
    "<think></think>",
    "<think>Reasoning</think>literal </think> tail",
  ]) {
    const split = reportedReasoning(text)!;
    assert.ok(split);
    assert.equal(split.block + split.answer, text);
    assert.ok(split.block.endsWith("</think>"));
  }
});
test("Code, inline tags, incomplete streams and ambiguous nested blocks stay literal", () => {
  for (const text of [
    "",
    "ordinary text",
    "Explain <think>abc</think>",
    "```xml\n<think>abc</think>\n```",
    "<thi",
    "<think>not closed",
    "<think>nested <think>text</think>",
    "</think>answer",
  ])
    assert.equal(reportedReasoning(text), null);
});
