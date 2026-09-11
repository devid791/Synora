import test from "node:test";
import assert from "node:assert/strict";
import {
  readOpenAiModels,
  validateOpenAiSelection,
  prepareOpenAiProcess,
} from "../src/engine/openai-provider";
import { configSchema, OPENAI_ENDPOINT } from "../src/shared/contracts";
// @ts-expect-error JS protocol fixture has no declaration file
import { coreModel } from "./fixtures/core-model.mjs";

function catalog(pages: unknown[], account: unknown = { type: "apiKey" }) {
  const calls: { method: string; params: any }[] = [];
  let i = 0;
  return {
    calls,
    async request<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (method === "account/read")
        return { account, requiresOpenaiAuth: true } as T;
      assert.equal(method, "model/list");
      return structuredClone(pages[Math.min(i++, pages.length - 1)]) as T;
    },
  };
}
test("Original catalog preserves wire vs picker identity, pagination, defaults and no invented context", async () => {
  const second = {
    ...coreModel,
    id: "other-picker",
    model: "other-wire",
    isDefault: false,
    supportedReasoningEfforts: [],
  };
  const t = catalog([
    { data: [coreModel], nextCursor: "next" },
    { data: [second], nextCursor: null },
  ]);
  const models = await readOpenAiModels(t);
  assert.deepEqual(
    models.map((m) => m.id),
    ["wire-fixture", "other-wire"],
  );
  assert.deepEqual(models[0].coreModel, coreModel);
  assert.deepEqual(models[0].reasoning_efforts, ["low", "high"]);
  assert.equal(models[0].default_reasoning_effort, "low");
  assert.equal(models[1].default_reasoning_effort, undefined);
  assert.ok(
    models.every(
      (m) => m.context_window === null && m.context_window_options.length === 0,
    ),
  );
  assert.deepEqual(t.calls, [
    { method: "account/read", params: { refreshToken: false } },
    {
      method: "model/list",
      params: { includeHidden: false, limit: 100, cursor: null },
    },
    {
      method: "model/list",
      params: { includeHidden: false, limit: 100, cursor: "next" },
    },
  ]);
  validateOpenAiSelection(models, "wire-fixture", "high");
  assert.throws(
    () => validateOpenAiSelection(models, "picker-fixture", "high"),
    /not advertised/,
  );
  assert.throws(
    () => validateOpenAiSelection(models, "wire-fixture", "ultra-fast"),
    /not advertised/,
  );
  assert.throws(
    () => validateOpenAiSelection(models, "other-wire", "high"),
    /not advertised/,
  );
});
test("Missing auth, malformed, empty, ambiguous and repeated catalogs fail before inference", async () => {
  const absent = catalog([], null);
  await assert.rejects(readOpenAiModels(absent), /Sign in/);
  assert.equal(absent.calls.length, 1);
  for (const [pages, message] of [
    [[{ data: [] }], /no picker-visible/],
    [[{ data: [{ ...coreModel, hidden: true }] }], /no picker-visible/],
    [[{ data: [coreModel, coreModel] }], /ambiguous/],
    [[{ data: [{ ...coreModel, defaultReasoningEffort: "max" }] }], /default/],
    [
      [
        {
          data: [
            {
              ...coreModel,
              supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "" },
                { reasoningEffort: "high", description: "" },
              ],
            },
          ],
        },
      ],
      /ambiguous/,
    ],
    [
      [
        { data: [coreModel], nextCursor: "again" },
        { data: [], nextCursor: "again" },
      ],
      /repeated/,
    ],
    [
      [{ data: [{ model: "missing-schema-fields" }] }],
      /Invalid App Server modelList response:.*required property 'defaultReasoningEffort'/,
    ],
  ] as const)
    await assert.rejects(readOpenAiModels(catalog([...pages])), message);
});
test("OpenAI configuration cannot borrow Axiom credentials, custom endpoint, context or declared executors", async () => {
  const good = {
    id: "openai",
    name: "OpenAI",
    kind: "provider",
    providerType: "openai",
    endpoint: OPENAI_ENDPOINT,
    auth: "core-account",
    enabled: true,
    tools: [],
  };
  assert.ok(configSchema.safeParse(good).success);
  for (const patch of [
    { endpoint: "https://attacker.invalid" },
    { auth: "api-key" },
    { auth: "none" },
    { kind: "mcp" },
    { tools: ["fake"] },
    { executor: "http-mcp" },
  ])
    assert.equal(configSchema.safeParse({ ...good, ...patch }).success, false);
  assert.equal(
    configSchema.safeParse({ ...good, providerType: "axiom" }).success,
    false,
  );
  const options = {
    stateDirectory: "/unused",
    cwd: "/unused",
    model: "model",
    profile: "high",
    context: null,
    endpoint: OPENAI_ENDPOINT,
  };
  for (const patch of [
    { endpoint: "https://attacker.invalid" },
    { context: 262144 },
    { authorization: async () => "never-read" },
  ])
    await assert.rejects(
      prepareOpenAiProcess({ ...options, ...patch }),
      /original Core routes/,
    );
});
