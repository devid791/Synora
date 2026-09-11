// QA admission only. No app source, OS change, network request or process launch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { posix, win32, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const providerConfigs = Object.freeze([
  "playwright.openai-provider-desktop.config.ts",
  "playwright.xai-desktop.config.ts",
  "playwright.openrouter-desktop.config.ts",
  "playwright.anthropic-desktop.config.ts",
  "playwright.gemini-desktop.config.ts",
  "playwright.deepseek-desktop.config.ts",
  "playwright.mistral-desktop.config.ts",
  "playwright.compatible-desktop.config.ts",
]);

// Independently collected package identities, not interchangeable build labels.
// Updating this QA table grants no permission to run an OS isolation controller.
const candidates = {
  c7a7fb8: {
    win32: {
      root: "C:\\Synora_QA_c7a7fb8_20260909_6774e0336697",
      app: "out/production-qa-windows-c7a7fb8/win-unpacked",
      executable:
        "8028a6474d108161965f5922e264658586e72bd0f8117c0f7a30de1e5dfd6de3",
      asar: "8ebb0b9a50d3ebb19f04c230f4b991c17b18d51d1ab0401ede26c2ab7f8eae81",
    },
    darwin: {
      root: "/Users/synora/Synora_QA_c7a7fb8_GKlW63",
      app: "out/production-qa-macos-c7a7fb8/mac-arm64/Synora Harness Desktop.app/Contents",
      executable:
        "da91f9e3d8bd6f008df4736973013d8144b3ab0b083e7cbbbee04dd2715eb331",
      asar: "db3c920d6548da9f545dd6589d152910bbc75c6ce8b0052d073617839ac6682c",
    },
  },
  "6abb5b9": {
    win32: {
      root: "C:\\Synora_QA_6abb5b9_20260910_2e1a753a1d8a",
      app: "out/production-qa-windows-6abb5b9/win-unpacked",
      executable:
        "0178f51ced5f1923cc58b7876692317b220df7d81a6a2cd7587c54da0695727d",
      asar: "cdd59de23a53c5fbab17ebe86925666c996ea18a82ee977f81c11a9f43c12c02",
    },
    darwin: {
      root: "/Users/synora/Synora_QA_6abb5b9_OlcF9C",
      app: "out/production-qa-macos-6abb5b9/mac-arm64/Synora Harness Desktop.app/Contents",
      executable:
        "43979d2a00dbaec44159e86f258a22a8efa75c94e9478c8354d6541b0270e17e",
      asar: "b8d16e4ca7949c75d87fb6f49f944808574b9d9b7ca3e9c6cf5149625c8a4f1b",
    },
  },
};
for (const platforms of Object.values(candidates)) {
  for (const descriptor of Object.values(platforms)) Object.freeze(descriptor);
  Object.freeze(platforms);
}
Object.freeze(candidates);

export function candidatePlan(candidate, platform, directory, config) {
  assert.ok(Object.hasOwn(candidates, candidate), "Unqualified QA candidate");
  assert.ok(
    providerConfigs.includes(config),
    "Select one exact provider fixture",
  );
  assert.ok(["win32", "darwin"].includes(platform), "Native QA host required");
  const descriptor = candidates[candidate][platform];
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const root = descriptor.root;
  assert.equal(
    windows ? path.normalize(directory).toLowerCase() : directory,
    windows ? root.toLowerCase() : root,
    "Unexpected QA project; never run in an installed app or older tree",
  );
  const app = path.join(root, descriptor.app);
  const files = [
    {
      path: path.join(
        app,
        windows ? "Synora Harness Desktop.exe" : "MacOS/Synora Harness Desktop",
      ),
      sha256: descriptor.executable,
    },
    {
      path: path.join(
        app,
        windows ? "resources/app.asar" : "Resources/app.asar",
      ),
      sha256: descriptor.asar,
    },
  ];
  const plan = {
    candidate,
    platform,
    root,
    config,
    executable: files[0].path,
    files,
  };
  if (windows) {
    plan.qaHome =
      "C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-Mb5PPy";
    plan.core = path.join(
      plan.qaHome,
      "state/core-runtime/0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a/bin/codex.exe",
    );
    plan.launcher =
      "C:\\Synora_Production_QA_9cfc8ac\\out\\qa-core-launcher\\controlled-core.exe";
    files.push(
      {
        path: plan.core,
        sha256:
          "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b",
      },
      {
        path: plan.launcher,
        sha256:
          "0aa86256dfefca827dc8973dcd6338dafa07647c33e3a7f36e2354b9aa105fc8",
      },
      {
        path: path.join(plan.qaHome, "state/app-server/.windows-home.json"),
        sha256:
          "076351d7ede73b7d986135ab81ede4f5d849dd667d71b4ca4227ffd7653655b4",
      },
      {
        path: path.join(
          plan.qaHome,
          "state/app-server/native-axiom/.sandbox-secrets/sandbox_users.json",
        ),
        sha256:
          "e4a62e26a2d84d09696946d8b65c3737529e48e0da7aa5e98cea3bfed25edb1f",
      },
      {
        path: path.join(
          plan.qaHome,
          "state/app-server/native-axiom/.sandbox/setup_marker.json",
        ),
        sha256:
          "a9293d6c496acef647603f309ad9cb4381f8a8def437f1444f0102a03c7a4d02",
      },
    );
  }
  return plan;
}

export async function verifyCandidateFiles(plan, inspect = inspectFile) {
  for (const expected of plan.files) {
    const actual = await inspect(expected.path);
    assert.ok(
      actual.regular && !actual.linked,
      "Linked/non-file QA artifact rejected",
    );
    assert.equal(
      actual.sha256,
      expected.sha256,
      `QA identity changed: ${expected.path}`,
    );
  }
  return plan;
}

async function inspectFile(file) {
  const metadata = await lstat(file);
  // Reject a redirected parent as well as a redirected leaf. macOS app
  // executable/ASAR are regular files, not the Frameworks symlink hierarchy.
  const canonical = await realpath(file);
  const normalize =
    process.platform === "win32"
      ? (value) => win32.normalize(value).toLowerCase()
      : (value) => value;
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return {
    regular: metadata.isFile(),
    linked:
      metadata.isSymbolicLink() || normalize(canonical) !== normalize(file),
    sha256: hash.digest("hex"),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [candidate, config, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, "Unexpected QA arguments");
  const plan = candidatePlan(
    candidate,
    process.platform,
    process.cwd(),
    config,
  );
  console.log(JSON.stringify(await verifyCandidateFiles(plan)));
}
