import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import { LiveEngine } from "../src/engine/live-engine";
import { xaiModels, prepareXaiProcess } from "../src/engine/xai-provider";
import { sha256File } from "../src/engine/core-runtime";
import type { EngineBinding } from "../src/shared/contracts";

test("xAI adapter with original Core: full tools, actual command/result, cold resume and quiet-stream cancellation", async () => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const f = await controlledOpenAi({ xai: true });
  let binding: EngineBinding | undefined, engine: LiveEngine | undefined;
  const events: unknown[] = [];
  const create = () =>
    new LiveEngine(
      {
        provider: "synora_xai",
        executable: f.wrapper,
        stateDirectory: join(f.directory, "synora-xai"),
        endpoint: f.endpoint,
        model: "grok-4.6",
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
        sink: (v) => {
          events.push(v);
        },
      },
      prepareXaiProcess,
    );
  try {
    const catalog = await xaiModels(f.endpoint, f.key);
    expect(catalog[0].context_window).toBe(500000);
    expect(catalog[1].unavailableReason).toBeTruthy();
    engine = create();
    await engine.start(
      "owned-xai-conversation",
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
        (v) => v.type === "commandExecution" && v.status === "completed",
      ),
    ).toBe(true);
    expect(JSON.stringify(f.state.toolResult)).toContain(
      "SYNORA_PROVIDER_FILE_OK",
    );
    expect(
      await readFile(join(f.workspace, "provider-check.txt"), "utf8"),
    ).toBe("SYNORA_PROVIDER_FILE_OK\n");
    expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
    expect(first.selection?.contextRequestField).toBe("core-managed");
    expect(first.backendRequests ?? []).toEqual([]);
    expect(f.requests.filter((v) => v.completed)).toHaveLength(2);
    expect(
      f.requests.every(
        (v) => v.authorized && v.body.reasoning.effort === "high",
      ),
    ).toBe(true);
    await engine.dispose();
    engine = create();
    await engine.start(
      "owned-xai-conversation",
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
      "owned-xai-conversation",
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
      "owned-xai-conversation",
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
      "out/live-evidence/xai-provider-core.json",
      JSON.stringify(
        {
          scope:
            "Original Core + Synora xAI provider + controlled Responses; not public xAI inference",
          coreSha256: await sha256File(f.core),
          passed: true,
          first,
          binding,
          events,
          requests: f.requests,
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
      "out/live-evidence/xai-provider-core-failure.json",
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
    console.error(
      f.requests.map((v) => ({
        path: v.path,
        tools: v.body?.tools?.map((t: any) => ({
          name: t.name,
          description: t.description?.slice(0, 100),
        })),
      })),
    );
    console.error(
      await readFile(join(f.directory, "xai-core-stderr.log"), "utf8").catch(
        () => "No Core stderr",
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
