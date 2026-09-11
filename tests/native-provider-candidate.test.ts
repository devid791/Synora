import test from "node:test";
import assert from "node:assert/strict";
import {
  candidatePlan,
  providerConfigs,
  verifyCandidateFiles,
} from "./fixtures/native-provider-candidate.mjs";

const root = "C:\\Synora_QA_c7a7fb8_20260909_6774e0336697";
test("native provider admission binds all eight exact configs to the frozen app, never a development Electron", () => {
  for (const config of providerConfigs) {
    const p = candidatePlan("c7a7fb8", "win32", root, config);
    assert.equal(p.config, config);
    assert.ok(
      p.executable.endsWith("win-unpacked\\Synora Harness Desktop.exe"),
    );
    assert.equal(p.files.length, 7);
    for (const file of p.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(p.core!.endsWith("\\bin\\codex.exe"));
  }
});
test("native provider admission rejects arbitrary paths, configs, candidates and platforms", () => {
  for (const args of [
    ["__proto__", "win32", root, providerConfigs[0]],
    ["constructor", "win32", root, providerConfigs[0]],
    ["c858d967", "win32", root, providerConfigs[0]],
    [
      "c7a7fb8",
      "win32",
      "C:\\Synora_Production_QA_9cfc8ac",
      providerConfigs[0],
    ],
    ["c7a7fb8", "darwin", "/Applications", providerConfigs[0]],
    ["c7a7fb8", "linux", root, providerConfigs[0]],
    ["c7a7fb8", "win32", root, "playwright.config.ts"],
    ["c7a7fb8", "win32", root, "../" + providerConfigs[0]],
    ["c7a7fb8", "win32", root, providerConfigs[0] + "\n"],
  ])
    assert.throws(() => candidatePlan(args[0], args[1], args[2], args[3]));
});

const newPackages = [
  {
    platform: "win32",
    root: "C:\\Synora_QA_6abb5b9_20260910_2e1a753a1d8a",
    oldRoot: root,
    executable:
      "0178f51ced5f1923cc58b7876692317b220df7d81a6a2cd7587c54da0695727d",
    asar: "cdd59de23a53c5fbab17ebe86925666c996ea18a82ee977f81c11a9f43c12c02",
    count: 7,
  },
  {
    platform: "darwin",
    root: "/Users/synora/Synora_QA_6abb5b9_OlcF9C",
    oldRoot: "/Users/synora/Synora_QA_c7a7fb8_GKlW63",
    executable:
      "43979d2a00dbaec44159e86f258a22a8efa75c94e9478c8354d6541b0270e17e",
    asar: "b8d16e4ca7949c75d87fb6f49f944808574b9d9b7ca3e9c6cf5149625c8a4f1b",
    count: 2,
  },
];

for (const item of newPackages) {
  test(`6abb ${item.platform} admission binds all configs to collected package identities and rejects stale roots`, async () => {
    for (const config of providerConfigs) {
      const p = candidatePlan("6abb5b9", item.platform, item.root, config);
      assert.equal(p.candidate, "6abb5b9");
      assert.equal(p.files.length, item.count);
      assert.equal(p.files[0].sha256, item.executable);
      assert.equal(p.files[1].sha256, item.asar);
      assert.ok(p.executable.includes("production-qa-"));
      assert.ok(p.executable.includes("6abb5b9"));
      assert.equal(p.config, config);
      const old = candidatePlan("c7a7fb8", item.platform, item.oldRoot, config);
      // Original Core/prepared QA state stays pinned, not duplicated/reprovisioned.
      assert.deepEqual(p.files.slice(2), old.files.slice(2));
      for (const index of [0, 1]) {
        await assert.rejects(
          verifyCandidateFiles(p, async (path) => ({
            regular: true,
            linked: false,
            sha256:
              path === p.files[index].path
                ? old.files[index].sha256
                : p.files.find((file) => file.path === path)!.sha256,
          })),
          /QA identity changed/,
        );
      }
      for (const [candidate, directory] of [
        ["6abb5b9", item.oldRoot],
        ["c7a7fb8", item.root],
        ["6abb5b9", item.root + "-other"],
      ]) {
        assert.throws(
          () => candidatePlan(candidate, item.platform, directory, config),
          /Unexpected QA project/,
        );
      }
    }
  });
}
test("Mac admission pins the actual c7a7 package independently of Windows", () => {
  const p = candidatePlan(
    "c7a7fb8",
    "darwin",
    "/Users/synora/Synora_QA_c7a7fb8_GKlW63",
    providerConfigs[0],
  );
  assert.equal(p.files.length, 2);
  assert.ok(
    p.executable.endsWith(".app/Contents/MacOS/Synora Harness Desktop"),
  );
  assert.equal(
    p.files[1].sha256,
    "db3c920d6548da9f545dd6589d152910bbc75c6ce8b0052d073617839ac6682c",
  );
  assert.equal(p.qaHome, undefined);
});
test("admission independently checks every pinned file and refuses hash, file-type and link changes", async () => {
  const p = candidatePlan("c7a7fb8", "win32", root, providerConfigs[0]);
  const seen: string[] = [];
  const valid = async (path: string) => {
    seen.push(path);
    return {
      regular: true,
      linked: false,
      sha256: p.files.find((f) => f.path === path)!.sha256,
    };
  };
  await verifyCandidateFiles(p, valid);
  assert.deepEqual(
    seen,
    p.files.map((f) => f.path),
  );
  for (const bad of [
    { regular: false },
    { linked: true },
    { sha256: "0".repeat(64) },
  ]) {
    await assert.rejects(
      verifyCandidateFiles(p, async (path) => ({
        ...(await valid(path)),
        ...bad,
      })),
    );
  }
  await assert.rejects(
    verifyCandidateFiles(p, async () => {
      throw Error("No artifact");
    }),
    /No artifact/,
  );
});
