import test from "node:test";
import assert from "node:assert/strict";
import { messages } from "../src/renderer/locales/status-bar";
import { translate } from "../src/renderer/i18n";

test("Status bar headings, states and details have all six translations and exact placeholders", () => {
  const placeholders = (text: string) =>
    [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
  for (const [source, translations] of Object.entries(messages)) {
    assert.equal(translations.length, 6, source);
    for (const text of translations) {
      assert.ok(text.trim(), source);
      assert.deepEqual(placeholders(text), placeholders(source), source);
    }
    assert.equal(translate(messages, "en", source), source);
  }
  assert.equal(
    translate(messages, "it", "Awaiting approval"),
    "In attesa di approvazione",
  );
  assert.equal(
    translate(messages, "it", "{count} GPUs", { count: 2 }),
    "2 GPU",
  );
});
