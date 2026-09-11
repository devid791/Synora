import test from "node:test";
import assert from "node:assert/strict";
import { mergeMessage } from "../src/shared/message-history";

test("Interrupted output survives empty or shorter Core history without becoming completed or duplicated", () => {
  const empty = {
    id: "item-a",
    role: "assistant" as const,
    text: "",
    simulated: false,
  };
  let message = mergeMessage(undefined, empty, "started");
  assert.equal(message.incomplete, true);
  message = mergeMessage(
    message,
    { ...empty, text: "Actual partial output" },
    "interrupted",
  );
  assert.equal(message.incomplete, true);
  assert.deepEqual(mergeMessage(message, empty, "history"), message);
  assert.deepEqual(
    mergeMessage(message, { ...empty, text: "Actual" }, "history"),
    message,
  );
  assert.deepEqual(mergeMessage(message, empty, "started"), message);
  const completed = mergeMessage(
    message,
    { ...empty, text: "Actual complete output" },
    "completed",
  );
  assert.equal(completed.incomplete, false);
  assert.deepEqual(
    mergeMessage(completed, completed, "interrupted"),
    completed,
  );
  assert.equal(
    mergeMessage(
      message,
      { ...empty, text: "Authoritative replacement" },
      "history",
    ).text,
    "Authoritative replacement",
  );
});
