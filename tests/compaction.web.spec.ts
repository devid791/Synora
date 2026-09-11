import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { startWebService } from "../src/web/server";

test("Actual original Core/Axiom compaction, retained draft/history, cold resume and post-compaction recall", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-compact-ui-")),
    workspace = join(dir, "workspace");
  await mkdir(workspace);
  const marker = `ORBIT-${randomBytes(4).toString("hex").toUpperCase()}`;
  const options = {
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const complete = async () => {
    await expect
      .poll(
        () => {
          const s = server.service.engine.snapshot();
          if (s.status === "failed") throw Error(JSON.stringify(s.error));
          return s.status;
        },
        { timeout: 120000 },
      )
      .toBe("completed");
  };
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("compact-axiom");
    await page
      .getByLabel("Configuration name")
      .fill("Compaction qualification");
    await page
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_ENDPOINT!);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("compact-axiom");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await nav("Workspace");
    await expect(
      page.getByRole("button", { name: "Compact context", exact: true }),
    ).toBeDisabled();
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        `The project code is ${marker}. Retain this exact code for our next turn. Do not use tools. Reply only STORED.`,
      );
    await nav("Send message");
    await complete();
    const first = server.service.engine.snapshot(),
      before = server.service.store.read().conversations[0];
    expect(
      first.items.some(
        (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
      ),
    ).toBe(false);
    await page
      .getByLabel("Message", { exact: true })
      .fill("This unsent draft must survive compaction.");
    await nav("Compact context");
    await expect
      .poll(() => server.service.engine.snapshot().turnId)
      .not.toBe(first.turnId);
    await complete();
    const compacted = server.service.engine.snapshot();
    expect(compacted.threadId).toBe(first.threadId);
    expect(compacted.sessionId).toBe(first.sessionId);
    const record = compacted.compactions?.find(
      (c) => c.turnId === compacted.turnId,
    );
    expect(record?.status).toBe("completed");
    expect(compacted.items.some((i) => i.type === "contextCompaction")).toBe(
      true,
    );
    const events = (await server.service.engine.reconnect(0)).events;
    const lifecycle = events.flatMap((e) =>
      e.event.kind === "protocol" &&
      "threadId" in e.event.payload.params &&
      e.event.payload.params.threadId === compacted.threadId
        ? [e.event.payload]
        : [],
    );
    expect(
      lifecycle.some(
        (e) => e.method === "item/started" && e.params.item.id === record!.id,
      ),
    ).toBe(true);
    expect(
      lifecycle.some(
        (e) => e.method === "item/completed" && e.params.item.id === record!.id,
      ),
    ).toBe(true);
    expect(
      lifecycle.some(
        (e) =>
          e.method === "turn/completed" &&
          e.params.turn.id === compacted.turnId &&
          e.params.turn.status === "completed",
      ),
    ).toBe(true);
    const after = server.service.store.read().conversations[0];
    for (const m of before.messages) expect(after.messages).toContainEqual(m);
    expect(after.draft).toBe("This unsent draft must survive compaction.");
    await expect(
      page.getByLabel("Context compaction").getByRole("status"),
    ).toHaveText("completed");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      after.draft,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel("Context compaction").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/compaction-web/compaction-390.png",
    });
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await complete();
    expect(server.service.engine.snapshot().sessionId).toBe(first.sessionId);
    expect(
      server.service.store.read().conversations[0].compactions,
    ).toContainEqual(record);
    await expect(
      page.getByLabel("Context compaction").getByRole("status"),
    ).toHaveText("completed");
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "What exact project code did I ask you to retain? Reply with just that code. Do not use tools.",
      );
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().turnId)
      .not.toBe(compacted.turnId);
    await complete();
    const final = server.service.engine.snapshot();
    await expect(page.locator(".message.assistant").last()).toHaveText(
      new RegExp(marker),
    );
    expect(final.threadId).toBe(first.threadId);
    expect(
      final.items.some(
        (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/compaction-actual.json",
      JSON.stringify(
        {
          passed: true,
          dir,
          marker,
          first,
          compacted,
          final,
          record,
          lifecycle,
          errors,
          scope:
            "Actual manual Core compaction over ordinary Axiom Responses, original identity and post-restart model recall; not a 262K saturation or automatic-threshold test",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/compaction-actual-failure.json",
      JSON.stringify(
        {
          dir,
          marker,
          error: String(error),
          snapshot: server.service.engine.snapshot(),
          state: server.service.store.read(),
          replay: await Promise.resolve(
            server.service.engine.reconnect(0),
          ).catch((e) => String(e)),
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await page.goto("about:blank").catch(() => {});
    await server.close();
  }
});
