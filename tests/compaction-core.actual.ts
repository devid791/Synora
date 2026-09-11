// Explicit live integration runner, never included in the offline test glob.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { LiveEngine } from "../src/engine/live-engine";
import { axiomModels, prepareAxiomProcess } from "../src/engine/axiom-process";
import type { EngineBinding, EventEnvelope } from "../src/shared/contracts";

test(
  "Original Core automatic compaction at a measured QA-only threshold retains actual Axiom recall",
  { timeout: 240000 },
  async () => {
    const endpoint = process.env.SYNORA_TEST_ENDPOINT;
    assert.ok(endpoint, "Explicit actual Axiom endpoint required");
    const dir = await mkdtemp(join(tmpdir(), "synora-automatic-compact-")),
      workspace = join(dir, "workspace");
    await mkdir(workspace);
    const catalog = await axiomModels(endpoint);
    const model = catalog.find(
      (m) =>
        m.reasoning_efforts.includes("ultra-fast") &&
        m.context_window_options.includes(262144),
    );
    assert.ok(model, "Use an actually advertised Axiom model/profile/context");
    const marker = `ORBIT-${randomBytes(4).toString("hex").toUpperCase()}`;
    const events: EventEnvelope[] = [];
    let binding: EngineBinding | undefined;
    const options = {
      stateDirectory: join(dir, "core"),
      endpoint,
      model: model.id,
      turnDeadlineMs: 120000,
      context: () => ({
        cwd: workspace,
        profile: "ultra-fast",
        context: 262144,
        binding,
      }),
      bind: (_: string, value: EngineBinding) => {
        binding = value;
      },
      sink: (e: EventEnvelope) => events.push(e),
    };
    let engine = new LiveEngine(options);
    const complete = async () => {
      const deadline = Date.now() + 125000;
      for (;;) {
        const s = engine.snapshot();
        if (s.status === "failed") throw Error(JSON.stringify(s.error));
        if (s.status === "completed") return s;
        if (Date.now() > deadline)
          throw Error("Actual automatic compaction did not terminate");
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    let threshold: number | undefined;
    try {
      await engine.start(
        "owned",
        `The project code is ${marker}. Retain this exact code for the next turn. Reply only STORED. Do not use tools.`,
        "text",
      );
      const first = await complete();
      assert.ok(first.tokenUsage && first.tokenUsage.last.totalTokens > 0);
      assert.ok(
        !first.items.some(
          (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
        ),
      );
      threshold = Math.max(
        1,
        Math.floor(first.tokenUsage.last.totalTokens / 2),
      );
      await engine.dispose();
      // Only this fresh, owned Core process gets the QA threshold. No app default,
      // production model context, KV tier, server setting or kernel is changed.
      engine = new LiveEngine(
        { ...options, initialSequence: first.sequence },
        async (value) => {
          const configured = await prepareAxiomProcess(value);
          return {
            ...configured,
            args: [
              ...configured.args,
              "-c",
              `model_auto_compact_token_limit=${threshold}`,
            ],
          };
        },
      );
      await engine.start(
        "owned",
        "What exact project code did I ask you to retain? Reply with just the code. Do not use tools.",
        "text",
      );
      const final = await complete();
      assert.equal(final.threadId, first.threadId);
      assert.equal(final.sessionId, first.sessionId);
      assert.ok(
        final.compactions?.some((c) => c.status === "completed"),
        "Original Core must actually emit a completed automatic compaction",
      );
      assert.ok(
        final.items.some(
          (i) => i.type === "agentMessage" && i.text.includes(marker),
        ),
        "Actual model must retain the code after automatic compaction",
      );
      assert.ok(
        !final.items.some(
          (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
        ),
      );
      await mkdir("out/live-evidence", { recursive: true });
      await writeFile(
        "out/live-evidence/compaction-automatic-actual.json",
        JSON.stringify(
          {
            passed: true,
            dir,
            marker,
            threshold,
            first,
            final,
            events,
            scope:
              "Original Core automatic mechanism with QA-only threshold derived from measured usage; actual Axiom recall, not a 262K saturation or public-provider qualification",
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir("out/live-evidence", { recursive: true });
      await writeFile(
        "out/live-evidence/compaction-automatic-failure.json",
        JSON.stringify(
          {
            dir,
            marker,
            threshold,
            error: String(error),
            snapshot: engine.snapshot(),
            events,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      await engine.dispose();
    }
  },
);
