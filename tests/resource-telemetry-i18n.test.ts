import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/renderer/i18n";
import { messages } from "../src/renderer/locales/resource-telemetry";

// The shared runtime uses `pt` for Portuguese (Portugal).
const locales = ["it", "fr", "de", "es", "pt", "nl"] as const;
// Independent of the parent-owned dashboard: this is the agreed copy contract.
const keys = [
  "Resource usage",
  "Live measurements and reported samples stay separate.",
  "Local host RAM",
  "Non-free host memory, including OS and caches; not Synora alone.",
  "Synora service RAM",
  "Main process RSS as a share of host RAM; not all app processes.",
  "Axiom VRAM",
  "Last completed backend request; not necessarily this conversation. Sample time not reported.",
  "GPU utilization",
  "No live GPU utilization source is exposed by this backend.",
  "Context occupancy",
  "Latest Core report; not cumulative token consumption.",
  "Waiting for updated usage after compaction.",
  "Current turn tokens",
  "Conversation tokens",
  "Input / output",
  "Reasoning is included in output; cached input is included in input.",
  "Local memory history",
  "Last 120 seconds · service RSS / host RAM",
  "Decode speed",
  "Prefill speed",
  "Completed Axiom requests · not instantaneous throughput",
  "Measured suffix prefill only; cached tokens are excluded.",
  "No measurements yet",
  "Unavailable",
  "Stale",
  "Live sample",
  "Last request",
  "Latest report",
  "Not applicable",
  "Source: {source}",
  "Updated {time}",
  "Retrieved {time}; not the sample time",
  "{used} / {total} GiB",
  "{percent}% used",
  "{rate} tok/s",
  "Waiting for backend observation",
  "Not exposed by this provider",
  "Historical counters; no current-turn report yet.",
  "Reported counters update when Core emits usage.",
  "No capacity reported; no percentage inferred.",
  "Refresh paused while hidden",
  "GPU task busy",
  "GPU task idle",
] as const;

const placeholders = (text: string) =>
  [...text.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();

test("Resource telemetry contains exactly the 44 agreed English keys", () => {
  assert.equal(keys.length, 44);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(Object.keys(messages).sort(), [...keys].sort());
});

test("Resource telemetry has six nonempty translations in locale order with exact placeholders", () => {
  const languageNeutral = new Set(["{used} / {total} GiB", "{rate} tok/s"]);
  for (const [key, values] of Object.entries(messages)) {
    assert.equal(values.length, locales.length, key);
    for (const [index, text] of values.entries()) {
      const label = `${locales[index]}: ${key}`;
      assert.equal(typeof text, "string", label);
      assert.ok(text.trim(), label);
      assert.equal(text, text.trim(), label);
      assert.doesNotMatch(text, /\p{Script=Han}/u, label);
      assert.deepEqual(placeholders(text), placeholders(key), label);
      assert.equal(translate(messages, locales[index], key), text, label);
      if (!languageNeutral.has(key)) assert.notEqual(text, key, label);
    }
  }
});

test("English resource telemetry retains every original source key", () => {
  for (const key of keys) {
    assert.equal(translate(messages, "en", key), key);
  }
});

test("Resource telemetry interpolates every placeholder without rewriting dynamic values", () => {
  const parameterSets: Record<string, string | number>[] = [
    {
      source: "axiom_backend/native_tool__id/<&> {time} $&",
      time: "12:34:56 UTC {source}",
      used: 0,
      total: 32,
      percent: 0,
      rate: 42.5,
    },
    {
      source: "Core/usage__report {source}",
      time: "10/09/2026 12:34:56",
      used: "1,25",
      total: "32,00",
      percent: "3,91",
      rate: "42,50",
    },
  ];
  for (const locale of ["en", ...locales] as const) {
    for (const key of keys.filter((key) => placeholders(key).length > 0)) {
      for (const params of parameterSets) {
        const template = translate(messages, locale, key);
        const expected = template.replace(
          /\{([A-Za-z_][A-Za-z_0-9]*)\}/g,
          (_match, name: string) => String(params[name]),
        );
        assert.equal(
          translate(messages, locale, key, params),
          expected,
          `${locale}: ${key}`,
        );
      }
    }
    assert.equal(
      translate(messages, locale, "{used} / {total} GiB", { used: 0 }),
      "0 / {total} GiB",
      `${locale}: missing values stay explicit`,
    );
    const backendIdentity = "backend__usage/original <&> {source}";
    assert.equal(translate(messages, locale, backendIdentity), backendIdentity);
  }
});

test("Resource telemetry preserves technical identities, units and the history window", () => {
  const technicalTerms = (text: string) =>
    [...text.matchAll(/\b(?:Synora|Axiom|Core|RAM|RSS|VRAM|GPU|GiB)\b/g)]
      .map((match) => match[0])
      .sort();
  for (const [key, values] of Object.entries(messages)) {
    for (const [index, text] of values.entries()) {
      assert.deepEqual(
        technicalTerms(text),
        technicalTerms(key),
        `${locales[index]}: ${key}`,
      );
    }
  }
  for (const locale of ["en", ...locales] as const) {
    assert.equal(
      translate(messages, locale, "{used} / {total} GiB", {
        used: 1.25,
        total: 32,
      }),
      "1.25 / 32 GiB",
    );
    assert.equal(
      translate(messages, locale, "{rate} tok/s", { rate: 42.5 }),
      "42.5 tok/s",
    );
    assert.match(
      translate(messages, locale, "{percent}% used", { percent: 0 }),
      /0\s?%/,
    );
    assert.match(
      translate(messages, locale, "Last 120 seconds · service RSS / host RAM"),
      /\b120\b/,
    );
  }
});

test("Resource telemetry keeps freshness, provenance and GPU task states distinct", () => {
  const states = [
    "No measurements yet",
    "Unavailable",
    "Stale",
    "Live sample",
    "Last request",
    "Latest report",
    "Not applicable",
    "Waiting for backend observation",
    "Not exposed by this provider",
    "Refresh paused while hidden",
    "GPU task busy",
    "GPU task idle",
  ];
  for (const locale of ["en", ...locales] as const) {
    const labels = states.map((key) => translate(messages, locale, key));
    assert.equal(new Set(labels).size, states.length, locale);
    assert.notEqual(
      translate(messages, locale, "Updated {time}"),
      translate(messages, locale, "Retrieved {time}; not the sample time"),
      `${locale}: retrieval time is not a measurement timestamp`,
    );
  }
});
