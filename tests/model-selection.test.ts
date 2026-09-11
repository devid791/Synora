import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { ModelCapabilities } from "../src/shared/contracts";
import {
  resolveModelSelection,
  selectionSchema,
  type ModelSelection,
} from "../src/shared/model-selection";
import {
  mountedProviderTypes,
  providerDefinitions,
} from "../src/shared/provider-registry";
// @ts-expect-error JS protocol fixture has no declaration file
import { coreModel } from "./fixtures/core-model.mjs";

// Pure, controlled catalogs: no provider, account, Core process or network I/O.
const selection: ModelSelection = {
  providerId: "Configured-Provider",
  model: "Exact/Model-v1",
};
function capabilities(
  overrides: Partial<ModelCapabilities> = {},
): ModelCapabilities {
  return {
    id: selection.model,
    context_window: 8192,
    context_window_options: [2048, 8192],
    reasoning_efforts: ["low", "high"],
    ...overrides,
  };
}
function providerMetadata(
  provider: NonNullable<ModelCapabilities["providerModel"]>["provider"],
): NonNullable<ModelCapabilities["providerModel"]> {
  return {
    provider,
    aliases: ["Alias", "Luna"],
    inputModalities: ["text"],
    description: "Controlled selection fixture, not a live access claim",
  };
}

test("strict selection schema preserves exact values and optional omission", () => {
  assert.deepEqual(selectionSchema.parse(selection), selection);
  const exact = {
    providerId: " Provider/MiXeD ",
    model: " Model/MiXeD ",
    effort: " Provider-Effort ",
    context: 4096,
  };
  assert.deepEqual(selectionSchema.parse(exact), exact);
  assert.equal(selectionSchema.parse({ ...selection, context: 1 }).context, 1);
  assert.equal(
    selectionSchema.parse({ ...selection, context: Number.MAX_SAFE_INTEGER })
      .context,
    Number.MAX_SAFE_INTEGER,
  );
});

test("schema and resolver reject malformed input, empty effort and extra fields", () => {
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    "model",
    {},
    { model: selection.model },
    { providerId: selection.providerId },
    ...["", null, 1, false].flatMap((value) => [
      { ...selection, providerId: value },
      { ...selection, model: value },
      { ...selection, effort: value },
    ]),
    ...[
      null,
      "2048",
      false,
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ].map((context) => ({ ...selection, context })),
    ...["profile", "providerType", "token", "aliases", "extra"].map((key) => ({
      ...selection,
      [key]: "not allowed",
    })),
  ];
  for (const value of invalid) {
    assert.equal(selectionSchema.safeParse(value).success, false);
    assert.throws(
      () =>
        resolveModelSelection(value as ModelSelection, "openai", [
          capabilities(),
        ]),
      z.ZodError,
    );
  }
});

test("only omitted provider type retains the legacy Axiom route", () => {
  const model = capabilities({ context_window_options: [2048] });
  assert.deepEqual(
    resolveModelSelection(selection, undefined, [model]),
    resolveModelSelection(selection, "axiom", [model]),
  );
  for (const type of [
    "",
    "AXIOM",
    "OpenAI",
    " openai",
    "unknown",
    "Luna",
    "__proto__",
    "constructor",
    "toString",
    "prototype",
  ])
    assert.throws(
      () => resolveModelSelection(selection, type, [model]),
      /Unknown provider adapter/,
    );
  assert.throws(
    () => resolveModelSelection(selection, null as unknown as string, [model]),
    /Unknown provider adapter/,
  );
});

test("provider mounting is checked on every resolution", (t) => {
  const model = capabilities();
  assert.equal(
    resolveModelSelection(selection, "openai", [model]).context,
    null,
  );
  // Scoped in-memory override; restore even if the assertion fails.
  const descriptor = Object.getOwnPropertyDescriptor(
    providerDefinitions.openai,
    "mounted",
  )!;
  t.after(() =>
    Object.defineProperty(providerDefinitions.openai, "mounted", descriptor),
  );
  Object.defineProperty(providerDefinitions.openai, "mounted", {
    ...descriptor,
    value: false,
  });
  assert.throws(
    () => resolveModelSelection(selection, "openai", [model]),
    /inference adapter is not mounted/,
  );
});

test("all mounted provider families accept their exact catalog model and effort", () => {
  for (const type of mountedProviderTypes) {
    const model = capabilities({
      context_window_options: [2048],
      ...(type !== "axiom" && type !== "openai"
        ? { providerModel: providerMetadata(type) }
        : {}),
    });
    const requested = { ...selection, effort: "high" };
    const resolved = resolveModelSelection(requested, type, [model]);
    assert.deepEqual(resolved.selection, requested);
    assert.equal(resolved.profile, "high", type);
    assert.equal(resolved.context, type === "axiom" ? 2048 : null, type);
    assert.equal(resolved.model, model);
  }
});

test("model IDs are exact: no alias, display name, case folding or default fallback", () => {
  const model = capabilities({ providerModel: providerMetadata("compatible") });
  for (const id of [
    "Luna",
    "Alias",
    "Exact/Model",
    "exact/model-v1",
    "Exact/Model-v1 ",
    " Exact/Model-v1",
    "unknown",
  ])
    assert.throws(
      () =>
        resolveModelSelection({ ...selection, model: id }, "compatible", [
          model,
        ]),
      /not advertised by the current provider catalog/,
    );
  assert.throws(
    () => resolveModelSelection(selection, "compatible", []),
    /not advertised by the current provider catalog/,
  );
  // An alias-looking name is valid only if independently advertised as an ID.
  const actualLuna = capabilities({ id: "Luna" });
  assert.equal(
    resolveModelSelection({ ...selection, model: "Luna" }, "compatible", [
      model,
      actualLuna,
    ]).model,
    actualLuna,
  );
});

test("selection uses the Core inference ID, never picker/display/upgrade IDs", () => {
  const model = capabilities({ id: coreModel.model, coreModel });
  assert.equal(
    resolveModelSelection({ ...selection, model: coreModel.model }, "openai", [
      model,
    ]).model,
    model,
  );
  for (const id of [coreModel.id, coreModel.displayName, "upgrade-fixture"])
    assert.throws(
      () =>
        resolveModelSelection({ ...selection, model: id }, "openai", [model]),
      /not advertised/,
    );
});

test("duplicate exact model IDs are ambiguous, including unavailable duplicates", () => {
  const model = capabilities();
  for (const duplicate of [model, { ...model, unavailableReason: "Retired" }])
    assert.throws(
      () => resolveModelSelection(selection, "openai", [model, duplicate]),
      /ambiguous/,
    );
});

test("unavailable models never fall back to another available model", () => {
  for (const type of mountedProviderTypes) {
    for (const unavailableReason of ["Account access revoked", ""]) {
      const model = capabilities({ unavailableReason });
      assert.throws(
        () =>
          resolveModelSelection(selection, type, [
            model,
            capabilities({ id: "Available-Alternative" }),
          ]),
        /Selected model is unavailable/,
      );
    }
  }
});

test("contradictory provider/Core provenance rejects stale or misrouted catalogs", () => {
  const cases: [string | undefined, ModelCapabilities][] = [
    ["anthropic", capabilities({ providerModel: providerMetadata("xai") })],
    ["openai", capabilities({ providerModel: providerMetadata("compatible") })],
    [undefined, capabilities({ providerModel: providerMetadata("mistral") })],
    [
      "axiom",
      capabilities({ coreModel: { ...coreModel, model: selection.model } }),
    ],
    ["openai", capabilities({ coreModel })],
    [
      "openai",
      capabilities({
        coreModel: { ...coreModel, model: selection.model, hidden: true },
      }),
    ],
  ];
  for (const [type, model] of cases)
    assert.throws(
      () => resolveModelSelection(selection, type, [model]),
      /metadata differs.*reload the catalog/,
    );
});

test("explicit effort must be advertised by the selected model, not another model", () => {
  for (const type of mountedProviderTypes) {
    const model = capabilities({ context_window_options: [2048] });
    for (const effort of [
      "HIGH",
      " high",
      "high ",
      "medium",
      "ultra-fast",
      "none",
    ])
      assert.throws(
        () =>
          resolveModelSelection({ ...selection, effort }, type, [
            model,
            capabilities({ id: "Other", reasoning_efforts: [effort] }),
          ]),
        /Selected reasoning effort is not advertised/,
      );
  }
});

test("only an advertised default fills missing effort; explicit effort wins", () => {
  for (const type of mountedProviderTypes) {
    const model = capabilities({
      context_window_options: [2048],
      default_reasoning_effort: "high",
    });
    const resolved = resolveModelSelection(selection, type, [model]);
    assert.equal(resolved.profile, "high", type);
    assert.deepEqual(resolved.selection, selection);
    assert.equal(Object.hasOwn(resolved.selection, "effort"), false);
    assert.equal(
      resolveModelSelection({ ...selection, effort: "low" }, type, [model])
        .profile,
      "low",
    );
  }
});

test("without a default, omission never invents a profile or selects the first/sole effort", () => {
  for (const type of mountedProviderTypes) {
    for (const reasoning_efforts of [[], ["high"], ["high", "low"]]) {
      const model = capabilities({
        reasoning_efforts,
        context_window_options: [2048],
      });
      assert.equal(resolveModelSelection(selection, type, [model]).profile, "");
      assert.equal(
        resolveModelSelection({ ...selection, effort: undefined }, type, [
          model,
        ]).profile,
        "",
      );
    }
  }
});

test("Core metadata cannot supply an unadvertised top-level default", () => {
  const model = capabilities({
    id: coreModel.model,
    coreModel,
    reasoning_efforts: [],
  });
  assert.equal(
    resolveModelSelection({ ...selection, model: model.id }, "openai", [model])
      .profile,
    "",
  );
});

test("models with no advertised efforts reject every explicit effort", () => {
  for (const type of mountedProviderTypes) {
    const model = capabilities({
      reasoning_efforts: [],
      context_window_options: [2048],
    });
    for (const effort of ["high", "none", "auto"])
      assert.throws(
        () => resolveModelSelection({ ...selection, effort }, type, [model]),
        /Selected reasoning effort is not advertised/,
      );
  }
});

test("invalid defaults reject even when the explicit requested effort is valid", () => {
  for (const type of mountedProviderTypes) {
    for (const default_reasoning_effort of ["max", "HIGH", " high", ""]) {
      const model = capabilities({
        context_window_options: [2048],
        default_reasoning_effort,
      });
      for (const effort of [undefined, "low"])
        assert.throws(
          () => resolveModelSelection({ ...selection, effort }, type, [model]),
          /default reasoning effort is not advertised/,
        );
    }
  }
  for (const reasoning_efforts of [[], [""]])
    assert.throws(
      () =>
        resolveModelSelection(selection, "openai", [
          capabilities({
            reasoning_efforts,
            default_reasoning_effort: "",
          }),
        ]),
      /default reasoning effort is not advertised/,
    );
  assert.throws(
    () =>
      resolveModelSelection(selection, "openai", [
        capabilities({
          reasoning_efforts: [],
          default_reasoning_effort: "high",
        }),
      ]),
    /default reasoning effort is not advertised/,
  );
});

test("empty effort is rejected even when erroneously advertised; none is an exact option", () => {
  assert.throws(
    () =>
      resolveModelSelection({ ...selection, effort: "" }, "openai", [
        capabilities({
          reasoning_efforts: [""],
        }),
      ]),
    z.ZodError,
  );
  const model = capabilities({
    reasoning_efforts: ["none"],
    default_reasoning_effort: "none",
  });
  assert.equal(
    resolveModelSelection(selection, "mistral", [model]).profile,
    "none",
  );
  assert.equal(
    resolveModelSelection({ ...selection, effort: "none" }, "mistral", [model])
      .profile,
    "none",
  );
});

test("provider-specific efforts and original strings are preserved without global enums", () => {
  const requested = {
    providerId: " Provider ",
    model: " Model/Case ",
    effort: " Effort/Case ",
  };
  const model = capabilities({
    id: requested.model,
    reasoning_efforts: [requested.effort],
  });
  const resolved = resolveModelSelection(requested, "compatible", [model]);
  assert.deepEqual(resolved.selection, requested);
  assert.equal(resolved.profile, requested.effort);
  assert.equal(resolved.model, model);
});

test("Axiom honors every exact discrete context, never context_window as an override", () => {
  const model = capabilities({ context_window: 16384 });
  for (const context of model.context_window_options)
    assert.equal(
      resolveModelSelection({ ...selection, context }, "axiom", [model])
        .context,
      context,
    );
  for (const context of [1, 4096, 16384, 32768])
    assert.throws(
      () =>
        resolveModelSelection({ ...selection, context }, "axiom", [
          model,
          capabilities({ id: "Other", context_window_options: [context] }),
        ]),
      /Selected context is not advertised/,
    );
});

test("Axiom infers only a valid sole context and leaves the requested selection unchanged", () => {
  const model = capabilities({
    context_window: 8192,
    context_window_options: [2048],
  });
  const resolved = resolveModelSelection(selection, "axiom", [model]);
  assert.equal(resolved.context, 2048);
  assert.deepEqual(resolved.selection, selection);
  assert.equal(Object.hasOwn(resolved.selection, "context"), false);
});

test("Axiom missing context rejects absent or multiple options instead of picking max/default", () => {
  for (const options of [[], [2048, 8192], [8192, 2048], [2048, 2048]])
    assert.throws(
      () =>
        resolveModelSelection(selection, "axiom", [
          capabilities({
            context_window: 8192,
            context_window_options: options,
          }),
        ]),
      /requires an explicit advertised context/,
    );
  assert.throws(
    () =>
      resolveModelSelection({ ...selection, context: 8192 }, "axiom", [
        capabilities({
          context_window_options: [],
        }),
      ]),
    /Selected context is not advertised/,
  );
});

test("Axiom rejects malformed catalog context options, including derived sole choices", () => {
  for (const invalid of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const options of [[invalid], [2048, invalid]])
      assert.throws(
        () =>
          resolveModelSelection(selection, "axiom", [
            capabilities({
              context_window_options: options,
            }),
          ]),
        /catalog advertises an invalid context option/,
      );
    assert.throws(
      () =>
        resolveModelSelection({ ...selection, context: 2048 }, "axiom", [
          capabilities({
            context_window_options: [2048, invalid],
          }),
        ]),
      /catalog advertises an invalid context option/,
    );
  }
});

test("every external adapter rejects explicit context even if discrete options advertise it", () => {
  for (const type of mountedProviderTypes.filter((type) => type !== "axiom")) {
    for (const context_window_options of [[], [2048], [2048, 8192]]) {
      const model = capabilities({ context_window_options });
      const resolved = resolveModelSelection(selection, type, [model]);
      assert.equal(resolved.context, null, type);
      assert.equal(Object.hasOwn(resolved.selection, "context"), false);
      for (const context of [2048, 8192, 16384])
        assert.throws(
          () => resolveModelSelection({ ...selection, context }, type, [model]),
          /does not support context overrides.*Core-managed context/,
        );
    }
    assert.equal(
      resolveModelSelection(selection, type, [
        capabilities({
          context_window: null,
          context_window_options: [],
        }),
      ]).context,
      null,
    );
  }
});

test("persisted selections are revalidated against each supplied refreshed catalog", () => {
  const requested = { ...selection, effort: "high", context: 8192 };
  const original = capabilities();
  assert.equal(
    resolveModelSelection(requested, "axiom", [original]).model,
    original,
  );
  const staleCases: [ModelCapabilities[], RegExp][] = [
    [[], /not advertised by the current provider catalog/],
    [
      [capabilities({ id: "New-Model" })],
      /not advertised by the current provider catalog/,
    ],
    [
      [capabilities({ unavailableReason: "Removed entitlement" })],
      /unavailable/,
    ],
    [
      [capabilities({ reasoning_efforts: ["low"] })],
      /Selected reasoning effort/,
    ],
    [[capabilities({ context_window_options: [2048] })], /Selected context/],
    [
      [capabilities({ default_reasoning_effort: "removed-default" })],
      /default reasoning effort/,
    ],
  ];
  for (const [models, message] of staleCases)
    assert.throws(
      () => resolveModelSelection(requested, "axiom", models),
      message,
    );
  const updated = capabilities({ default_reasoning_effort: "low" });
  assert.equal(
    resolveModelSelection(requested, "axiom", [updated]).model,
    updated,
  );
  assert.deepEqual(requested, { ...selection, effort: "high", context: 8192 });
});

test("supervisor and worker catalogs/defaults remain independent with no cached resolution", () => {
  const supervisor = { ...selection, providerId: "Supervisor" };
  const worker = { ...selection, providerId: "Worker" };
  const supervisorModel = capabilities({ default_reasoning_effort: "low" });
  const workerModel = capabilities({
    default_reasoning_effort: "high",
    context_window_options: [2048],
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(
      resolveModelSelection(supervisor, "anthropic", [supervisorModel]).profile,
      "low",
    );
    const resolved = resolveModelSelection(worker, "axiom", [workerModel]);
    assert.equal(resolved.selection.providerId, "Worker");
    assert.equal(resolved.profile, "high");
    assert.equal(resolved.context, 2048);
  }
  const updated = capabilities({ default_reasoning_effort: "high" });
  assert.equal(
    resolveModelSelection(supervisor, "anthropic", [updated]).profile,
    "high",
  );
});

test("resolution does not mutate frozen selections, catalogs or metadata", () => {
  const model = capabilities({
    default_reasoning_effort: "high",
    providerModel: providerMetadata("compatible"),
  });
  const models = [model],
    requested = { ...selection };
  const before = structuredClone({ requested, models });
  Object.freeze(requested);
  Object.freeze(model.reasoning_efforts);
  Object.freeze(model.context_window_options);
  Object.freeze(model.providerModel!.aliases);
  Object.freeze(model.providerModel!.inputModalities);
  Object.freeze(model.providerModel);
  Object.freeze(model);
  Object.freeze(models);
  const resolved = resolveModelSelection(requested, "compatible", models);
  assert.deepEqual({ requested, models }, before);
  assert.deepEqual(resolved.selection, requested);
  assert.notEqual(resolved.selection, requested);
  assert.equal(resolved.model, model);
});
