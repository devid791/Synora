// Original Core and actual shell execution. Controlled xAI-shaped Responses,
// NOT a public xAI account, provider grant or inference qualification.
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import { LiveEngine } from "../src/engine/live-engine";
import { sha256File } from "../src/engine/core-runtime";
import {
  prepareOpenAiProcess,
  openAiModels,
} from "../src/engine/openai-provider";
import type { EngineBinding } from "../src/shared/contracts";

test("original Core: complete catalog through JSON functions, real exec/result, incremental text and cold resume", async () => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const f = await controlledOpenAi({ jsonFunctions: true });
  const home = join(f.directory, "account");
  let engine: LiveEngine | undefined;
  // Core account setup API is exercised by the existing account tests. This
  // disposable owned file supplies only the loopback-fixture credential.
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: f.key }),
    { mode: 0o600 },
  );
  let binding: EngineBinding | undefined;
  const records: unknown[] = [];
  try {
    const models = await openAiModels({
      stateDirectory: home,
      executable: f.wrapper,
    });
    const model = models.find((m) => m.coreModel?.isDefault)!;
    expect(model).toBeTruthy();
    const create = () =>
      new LiveEngine(
        {
          provider: "openai",
          stateDirectory: home,
          executable: f.wrapper,
          endpoint: "https://api.openai.com/v1",
          model: model.id,
          context: () => ({
            cwd: f.workspace,
            profile: model.default_reasoning_effort ?? "",
            context: null,
            binding,
          }),
          bind: (_id, b) => {
            binding = b;
          },
          sink: (v) => {
            records.push(v);
          },
        },
        prepareOpenAiProcess,
      );
    engine = create();
    await engine.start(
      "owned-conversation",
      "Read provider-check.txt and confirm the exact result.",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    const first = engine.snapshot();
    expect(first.firstDeltaAt).toBeTruthy();
    expect(
      first.items.some(
        (i) => i.type === "commandExecution" && i.status === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(f.state.toolResult)).toContain(
      "SYNORA_PROVIDER_FILE_OK",
    );
    expect(
      await readFile(join(f.workspace, "provider-check.txt"), "utf8"),
    ).toBe("SYNORA_PROVIDER_FILE_OK\n");
    expect(binding?.sessionId).toBe(first.sessionId);
    await engine.dispose();
    engine = create();
    await engine.start(
      "owned-conversation",
      "Confirm the same file result again.",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    expect(engine.snapshot().sessionId).toBe(first.sessionId);
    expect(engine.snapshot().threadId).toBe(first.threadId);
    expect(f.errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/responses-tool-codec-core.json",
      JSON.stringify(
        {
          scope:
            "Original Core with controlled JSON-function Responses, not public xAI inference or an installed xAI provider",
          coreSha256: await sha256File(f.core),
          passed: true,
          threadId: first.threadId,
          sessionId: first.sessionId,
          firstDeltaAt: first.firstDeltaAt,
          requests: f.requests.map(({ body, wireBody, ...r }) => ({
            ...r,
            inputTypes: wireBody?.input?.map((v: any) => v.type ?? v.role),
            wireToolTypes: wireBody?.tools?.map((v: any) => v.type),
          })),
          toolResult: f.state.toolResult,
          events: records,
          errors: f.errors,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await engine?.dispose();
    } finally {
      await f.close();
    }
  }
});
