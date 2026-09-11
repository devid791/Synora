// Focused CPU-only QA regression; no native app, Core, endpoint or live test.
// Run: node --import tsx --test tests/cancel-windows-locator.qa.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { chromium, expect } from "@playwright/test";
import { conversationTimeline } from "../src/renderer/conversation-timeline.ts";

test("Windows resumed identity survives the exact two-message negative and rejects stale/wrong replies", async () => {
  // Execute the exact production-QA helper body without registering/importing
  // the native test (which would require real prepared state and inference).
  const source = await readFile(
    new URL("./cancel-windows.desktop.spec.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "cancel.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const helpers = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "assertResumedAssistant",
  );
  assert.equal(helpers.length, 1);
  const code = ts.transpileModule(helpers[0].getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const check = new Function(
    "expect",
    "conversationTimeline",
    `${code};return assertResumedAssistant;`,
  )(expect.configure({ timeout: 150 }), conversationTimeline);
  const identity = {
    conversationId: "99bcbad6-6f52-475d-8d7e-24f0c9c5fda6",
    sessionId: "01a0898c-ee59-7c32-9f98-4495db170e29",
    threadId: "01a0898c-ee59-7c32-9f98-4495db170e29",
    turnId: "01a0898d-6727-7431-a011-be486bedb0ea",
    messageId: "msg-axiom-545",
  };
  // Exact assistant IDs/text from the preserved failed Windows conversation;
  // the first message belongs to the interrupted turn, not the resumed one.
  const messages = [
    {
      id: "msg-axiom-543",
      role: "assistant",
      text: "I'll run the PowerShell cancellation fixture as specified.\n\n",
      simulated: false,
    },
    {
      id: "msg-axiom-545",
      role: "assistant",
      text: "SYNORA_CANCEL_RESUMED",
      simulated: false,
    },
  ];
  const conversation = {
    id: identity.conversationId,
    binding: { threadId: identity.threadId, sessionId: identity.sessionId },
    messages,
    activity: [],
    itemOrder: messages.map((m) => m.id),
  };
  const snapshot = {
    ...identity,
    connection: "live",
    status: "completed",
    error: null,
    items: [
      {
        type: "agentMessage",
        id: identity.messageId,
        text: "SYNORA_CANCEL_RESUMED",
      },
    ],
  };
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ["--disable-gpu"],
  });
  let requests = 0;
  try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
      requests++;
      return route.abort();
    });
    const page = await context.newPage();
    const render = async (
      current = conversation,
      texts = current.messages.map((m) => m.text),
    ) => {
      await page.setContent("<main></main>");
      await page.evaluate(
        ({ current, texts }) => {
          window.synora = {
            state: async () => ({
              ok: true,
              value: { conversations: [current] },
            }),
          };
          for (const text of texts) {
            const article = document.createElement("article");
            article.className = "message assistant";
            const label = document.createElement("div");
            label.textContent = "Synora";
            const body = document.createElement("div");
            body.className = "message-text";
            body.textContent = text;
            article.append(label, body);
            document.querySelector("main").append(article);
          }
        },
        { current, texts },
      );
    };
    await render();
    await assert.rejects(
      () =>
        expect(page.locator(".message.assistant")).toContainText(
          "SYNORA_CANCEL_RESUMED",
          { timeout: 150 },
        ),
      /strict mode violation/,
    );
    await check(page, snapshot, identity);
    // Cold-side assertion must retain the same bound item/turn identity.
    await render(structuredClone(conversation));
    await check(page, structuredClone(snapshot), identity);
    const later = {
      ...conversation,
      messages: [
        ...messages,
        {
          id: "unrelated-later",
          role: "assistant",
          text: "Not the resumed reply",
          simulated: false,
        },
      ],
      itemOrder: [...conversation.itemOrder, "unrelated-later"],
    };
    await render(later);
    await check(page, snapshot, identity); // Exact identity is not .last().
    await assert.rejects(() =>
      check(page, { ...snapshot, turnId: "stale-turn" }, identity),
    );
    await assert.rejects(() =>
      check(
        page,
        { ...snapshot, conversationId: "wrong-conversation" },
        identity,
      ),
    );
    await assert.rejects(() =>
      check(
        page,
        {
          ...snapshot,
          items: [{ ...snapshot.items[0], id: "historical-only" }],
        },
        identity,
      ),
    );
    await assert.rejects(() =>
      check(
        page,
        {
          ...snapshot,
          items: [
            { ...snapshot.items[0], text: "SYNORA_CANCEL_RESUMED extra" },
          ],
        },
        identity,
      ),
    );
    // A correct marker in an older article cannot rescue the wrong bound body.
    await render(conversation, ["SYNORA_CANCEL_RESUMED", "wrong resumed body"]);
    await assert.rejects(() => check(page, snapshot, identity));
    assert.equal(requests, 0);
  } finally {
    await browser.close();
  }
  assert.equal(browser.isConnected(), false);
});
