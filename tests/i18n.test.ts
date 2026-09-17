import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { translate, type Messages } from "../src/renderer/i18n";
import { localeSchema } from "../src/shared/locale";
import { Store } from "../src/main/store";

test("Explicit UI translation preserves dynamic content verbatim", () => {
  const catalog: Messages = {
    "Model {name}": [
      "Modello {name}",
      "Modèle {name}",
      "Modell {name}",
      "Modelo {name}",
      "Modelo {name}",
      "Model {name}",
    ],
  };
  const identity = "native_tool__id/<script>{name}";
  assert.equal(
    translate(catalog, "it", "Model {name}", { name: identity }),
    `Modello ${identity}`,
  );
  assert.equal(
    translate(catalog, "en", "Model {name}", { name: identity }),
    `Model ${identity}`,
  );
  assert.equal(
    translate(catalog, "de", "Unmapped upstream error"),
    "Unmapped upstream error",
  );
  assert.equal(localeSchema.safeParse("invented").success, false);
});
test("Every shipped catalog has six translations with the exact original placeholders", async () => {
  const files = (await readdir("src/renderer/locales")).filter((f) =>
    f.endsWith(".ts"),
  );
  assert.equal(
    files.length,
    15,
    "All fifteen independently translated UI domains, including server hardware, must be present",
  );
  const placeholders = (s: string) =>
    [...s.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)].map((x) => x[1]).sort();
  let total = 0;
  for (const file of files) {
    const module = await import(
      pathToFileURL(join(process.cwd(), "src/renderer/locales", file)).href
    );
    const messages: Messages = module.messages;
    assert.ok(messages && Object.keys(messages).length > 0, file);
    for (const [source, values] of Object.entries(messages)) {
      total++;
      assert.equal(values.length, 6, `${file}: ${source}`);
      for (const text of values) {
        assert.ok(
          typeof text === "string" && text.trim(),
          `${file}: ${source}`,
        );
        assert.deepEqual(
          placeholders(text),
          placeholders(source),
          `${file}: ${source} → ${text}`,
        );
      }
    }
  }
  assert.ok(
    total > 100,
    "Actual application catalogs, not a few cosmetic labels",
  );
});
test("All literal t() calls resolve in their owned domain, not accidental English fallback", async () => {
  for (const file of (await readdir("src/renderer")).filter((f) =>
    f.endsWith(".tsx"),
  )) {
    const text = await readFile(join("src/renderer", file), "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imports = source.statements
      .filter(ts.isImportDeclaration)
      .map((s) => s.moduleSpecifier)
      .filter(ts.isStringLiteral);
    const domain = imports.find((s) => s.text.startsWith("./locales/"));
    if (!domain) continue;
    const { messages: primaryMessages } = await import(
      pathToFileURL(join(process.cwd(), "src/renderer", `${domain.text}.ts`))
        .href
    );
    const messages: Messages = { ...primaryMessages };
    // A component may explicitly compose owned catalogs. Only follow named
    // spreads in its `messages` initializer, not every incidental locale import.
    const composition = source.statements.filter(ts.isVariableStatement)
      .flatMap(statement => [...statement.declarationList.declarations])
      .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "messages")?.initializer;
    if (composition && ts.isObjectLiteralExpression(composition)) {
      for (const property of composition.properties) {
        if (!ts.isSpreadAssignment(property) || !ts.isIdentifier(property.expression)) continue;
        const name = property.expression.text;
        const catalog = source.statements.filter(ts.isImportDeclaration).find(statement => {
          const bindings = statement.importClause?.namedBindings;
          return ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith("./locales/") &&
            bindings && ts.isNamedImports(bindings) && bindings.elements.some(binding =>
              binding.name.text === name && (binding.propertyName ?? binding.name).text === "messages");
        });
        assert.ok(catalog && ts.isStringLiteral(catalog.moduleSpecifier), `${file}: unresolved owned catalog ${name}`);
        Object.assign(messages, (await import(pathToFileURL(join(process.cwd(), "src/renderer", `${catalog.moduleSpecifier.text}.ts`)).href)).messages);
      }
    }
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        assert.ok(
          Object.hasOwn(messages, node.arguments[0].text),
          `${file}: missing ${node.arguments[0].text}`,
        );
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
});
test("Language selection survives restart without changing engine, draft or permission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-language-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "state.sqlite");
    store = new Store(path);
    const c = store.conversation(null);
    store.draft(c.id, "Do not translate this user text");
    const engine = store.read().engine;
    for (const locale of localeSchema.options) {
      store.preferences({ locale });
      assert.equal(store.read().preferences.locale, locale);
      assert.deepEqual(store.read().engine, engine);
      assert.equal(store.read().preferences.permission, "ask");
    }
    store.preferences({ locale: "it" });
    store.close();
    store = new Store(path);
    assert.equal(store.read().preferences.locale, "it");
    assert.equal(
      store.read().conversations[0].draft,
      "Do not translate this user text",
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
