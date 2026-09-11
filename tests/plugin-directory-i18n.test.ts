import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { translate } from "../src/renderer/i18n";
import { messages } from "../src/renderer/locales/plugin-directory";

const locales = ["it", "fr", "de", "es", "pt", "nl"] as const;
const source = ts.createSourceFile(
  "PluginDirectory.tsx",
  readFileSync(
    new URL("../src/renderer/PluginDirectory.tsx", import.meta.url),
    "utf8",
  ),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const calls: ts.CallExpression[] = [];
function walk(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "t"
  ) {
    calls.push(node);
  }
  ts.forEachChild(node, walk);
}
walk(source);
const keys = new Set(
  calls.flatMap((call) => {
    const key = call.arguments[0];
    return key && ts.isStringLiteralLike(key) ? [key.text] : [];
  }),
);
const placeholders = (text: string) =>
  [...text.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();

test("Every literal PluginDirectory t() key has an owned translation entry", () => {
  assert.ok(keys.size > 0, "The TSX parser must find the actual UI keys");
  for (const key of keys) {
    assert.ok(Object.hasOwn(messages, key), `Missing translation: ${key}`);
  }
  assert.deepEqual(
    Object.keys(messages).sort(),
    [...keys].sort(),
    "Only current app-owned literal keys belong in this catalog",
  );
});

test("Plugin directory entries have six translations with exact placeholder parity and no Chinese", () => {
  for (const [key, values] of Object.entries(messages)) {
    assert.equal(values.length, locales.length, key);
    assert.doesNotMatch(key, /\p{Script=Han}/u, key);
    for (const [index, text] of values.entries()) {
      const label = `${locales[index]}: ${key}`;
      assert.equal(typeof text, "string", label);
      assert.ok(text.trim(), label);
      assert.doesNotMatch(text, /\p{Script=Han}/u, label);
      assert.deepEqual(placeholders(text), placeholders(key), label);
      assert.equal(translate(messages, locales[index], key), text, label);
    }
  }
});

test("English uses every original plugin directory key as its default", () => {
  for (const key of keys) {
    assert.equal(translate(messages, "en", key), key);
  }
});

test("Only literal app-owned copy is translated, never remote metadata", () => {
  for (const call of calls) {
    assert.ok(
      call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]),
      `Do not translate dynamic remote content: ${call.getText(source)}`,
    );
  }
  const name = "Remote Plugin / native_tool__id <&> {name}";
  const description = "Original remote description — keep {version} verbatim.";
  const params = { name, version: "1.2.3+remote", revision: "abc123" };
  for (const locale of ["en", ...locales] as const) {
    assert.equal(translate(messages, locale, name), name);
    assert.equal(translate(messages, locale, description), description);
    const template = translate(messages, locale, "Connection setup: {name}");
    assert.equal(
      translate(messages, locale, "Connection setup: {name}", params),
      template.replace("{name}", () => name),
      `${locale}: original name must survive interpolation without recursion`,
    );
  }
});
