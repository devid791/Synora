import { test, expect } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledGemini } from "./fixtures/gemini-upstream";
import { LiveEngine } from "../src/engine/live-engine";
import { prepareGeminiProcess } from "../src/engine/gemini-provider";
import { sha256File } from "../src/engine/core-runtime";
import type { EngineBinding } from "../src/shared/contracts";
test("Gemini native GenerateContent with original Core: signed history, actual tool/result, cold same-session recovery and cancellation", async () => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const f = await controlledGemini();
  let binding: EngineBinding | undefined, engine: LiveEngine | undefined;
  const events: any[] = [];
  const create = () =>
    new LiveEngine(
      {
        provider: "synora_gemini",
        executable: f.wrapper,
        stateDirectory: join(f.directory, "synora-gemini"),
        endpoint: f.endpoint,
        model: "gemini-fixture-native",
        authorization: async () => f.key,
        context: () => ({
          cwd: f.workspace,
          profile: "",
          context: null,
          binding,
        }),
        bind: (_id, b) => {
          binding = b;
        },
        sink: (e) => events.push(e),
      },
      prepareGeminiProcess,
    );
  try {
    engine = create();
    await engine.start(
      "owned-gemini-conversation",
      "Read provider-check.txt and confirm its contents",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    const first = engine.snapshot();
    expect(
      first.items.some(
        (x) => x.type === "commandExecution" && x.status === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(f.state.toolResult)).toContain(
      "SYNORA_PROVIDER_FILE_OK",
    );
    expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
    expect(f.requests).toHaveLength(2);
    expect(f.signed).toHaveLength(2);
    await engine.dispose();
    engine = create();
    await engine.start(
      "owned-gemini-conversation",
      "Confirm the same result",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    expect(engine.snapshot().threadId).toBe(first.threadId);
    expect(engine.snapshot().sessionId).toBe(first.sessionId);
    f.state.hold = true;
    await engine.start(
      "owned-gemini-conversation",
      "Hold for cancellation",
      "text",
    );
    await expect.poll(() => f.state.heldRequests).toBe(1);
    await engine.cancel();
    await expect.poll(() => f.state.cancelledStreams).toBe(1);
    expect(engine.snapshot().status).toBe("interrupted");
    expect(engine.snapshot().cleanupPending ?? false).toBe(false);
    f.state.hold = false;
    await engine.start(
      "owned-gemini-conversation",
      "Continue after cancellation",
      "text",
    );
    await expect
      .poll(() => (f.errors.length ? f.errors : engine!.snapshot().status), {
        timeout: 30000,
      })
      .toBe("completed");
    expect(engine.snapshot().threadId).toBe(first.threadId);
    expect(f.errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/gemini-provider-core.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Original Core native GenerateContent adapter + controlled Gemini; no public account or inference",
          coreSha256: await sha256File(f.core),
          first,
          final: engine.snapshot(),
          binding,
          events,
          requests: f.requests,
          signed: f.signed,
          toolResult: f.state.toolResult,
          cancellation: f.state.cancelledStreams,
          errors: f.errors,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/gemini-provider-core-failure.json",
      JSON.stringify(
        {
          snapshot: engine?.snapshot(),
          requests: f.requests,
          errors: f.errors,
        },
        null,
        2,
      ),
    );
    throw e;
  } finally {
    try {
      await engine?.dispose();
    } finally {
      await f.close();
    }
  }
});
