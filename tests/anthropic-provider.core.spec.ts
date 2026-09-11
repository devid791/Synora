import { test, expect } from "@playwright/test";
import { networkInterfaces } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledAnthropic } from "./fixtures/anthropic-upstream";
import { LiveEngine } from "../src/engine/live-engine";
import { prepareAnthropicProcess } from "../src/engine/anthropic-provider";
import { sha256File } from "../src/engine/core-runtime";
import type { EngineBinding } from "../src/shared/contracts";
test("Anthropic native Messages with original Core: signed thinking, actual tool/result, cold same-session recovery and cancellation", async () => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const f = await controlledAnthropic();
  let binding: EngineBinding | undefined, engine: LiveEngine | undefined;
  const events: any[] = [];
  const create = () =>
    new LiveEngine(
      {
        provider: "synora_anthropic",
        executable: f.wrapper,
        stateDirectory: join(f.directory, "synora-anthropic"),
        endpoint: f.endpoint,
        model: "claude-fixture-native",
        authorization: async () => f.key,
        context: () => ({
          cwd: f.workspace,
          profile: "high",
          context: null,
          binding,
        }),
        bind: (_id, b) => {
          binding = b;
        },
        sink: (e) => events.push(e),
      },
      prepareAnthropicProcess,
    );
  try {
    engine = create();
    await engine.start(
      "owned-anthropic-conversation",
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
      "owned-anthropic-conversation",
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
      "owned-anthropic-conversation",
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
      "owned-anthropic-conversation",
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
      "out/live-evidence/anthropic-provider-core.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Original Core native Messages adapter + controlled Anthropic; no public account or inference",
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
      "out/live-evidence/anthropic-provider-core-failure.json",
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
