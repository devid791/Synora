import test from "node:test";
import assert from "node:assert/strict";
import { ComposerHistory } from "../src/renderer/composer-history";

const messages = [
  { role: "user", text: "First\nmultiline" },
  { role: "assistant", text: "Never recall assistant output" },
  { role: "user", text: "Second · ciao" },
  { role: "user", text: "" },
];
test("Up/Down recall only user text in order, preserve duplicates and return the original draft", () => {
  const h = new ComposerHistory();
  assert.equal(
    h.recall("one", messages, "Draft", 0, 0, { key: "ArrowUp" }),
    "Second · ciao",
  );
  assert.equal(
    h.recall("one", messages, "Second · ciao", 13, 13, { key: "ArrowUp" }),
    "First\nmultiline",
  );
  assert.equal(
    h.recall("one", messages, "First\nmultiline", 15, 15, { key: "ArrowUp" }),
    "First\nmultiline",
  );
  assert.equal(
    h.recall("one", messages, "First\nmultiline", 15, 15, { key: "ArrowDown" }),
    "Second · ciao",
  );
  assert.equal(
    h.recall("one", messages, "Second · ciao", 13, 13, { key: "ArrowDown" }),
    "Draft",
  );
  assert.equal(
    h.recall("one", messages, "Draft", 5, 5, { key: "ArrowDown" }),
    null,
  );
  const repeated = [messages[0], messages[0]];
  assert.equal(
    h.recall("one", repeated, "", 0, 0, { key: "ArrowUp" }),
    "First\nmultiline",
  );
  assert.equal(
    h.recall("one", repeated, "First\nmultiline", 15, 15, { key: "ArrowUp" }),
    "First\nmultiline",
  );
  assert.equal(
    h.recall("one", repeated, "First\nmultiline", 15, 15, { key: "ArrowDown" }),
    "First\nmultiline",
  );
});
test("Caret navigation, selection, IME, modifiers, empty history and editing do not trigger recall", () => {
  const h = new ComposerHistory();
  assert.equal(
    h.recall("one", messages, "Draft", 4, 4, { key: "ArrowUp" }),
    null,
  );
  assert.equal(
    h.recall("one", messages, "Multi\nline", 0, 0, { key: "ArrowUp" }),
    null,
  );
  assert.equal(
    h.recall("one", messages, "Draft", 0, 3, { key: "ArrowUp" }),
    null,
  );
  for (const flag of [
    "shiftKey",
    "altKey",
    "ctrlKey",
    "metaKey",
    "isComposing",
  ])
    assert.equal(
      h.recall("one", messages, "", 0, 0, { key: "ArrowUp", [flag]: true }),
      null,
    );
  assert.equal(h.recall("one", [], "", 0, 0, { key: "ArrowUp" }), null);
  assert.equal(h.recall("one", messages, "", 0, 0, { key: "ArrowDown" }), null);
  assert.equal(
    h.recall("one", messages, "", 0, 0, { key: "ArrowUp" }),
    "Second · ciao",
  );
  assert.equal(
    h.recall("one", messages, "Edited", 6, 6, { key: "ArrowDown" }),
    null,
  );
});
test("A conversation switch or explicit reset cannot expose another conversation's history or saved draft", () => {
  const h = new ComposerHistory();
  assert.equal(
    h.recall("one", messages, "Private draft", 0, 0, { key: "ArrowUp" }),
    "Second · ciao",
  );
  assert.equal(h.recall("two", [], "", 0, 0, { key: "ArrowDown" }), null);
  assert.equal(h.recall("two", [], "", 0, 0, { key: "ArrowUp" }), null);
  h.recall("one", messages, "", 0, 0, { key: "ArrowUp" });
  h.reset();
  assert.equal(
    h.recall("one", messages, "Second · ciao", 13, 13, { key: "ArrowDown" }),
    null,
  );
});
