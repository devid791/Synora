import { test, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";
import { axiomFaultRelay, type FaultMode } from "./fixtures/axiom-fault-relay";
import type { AppServerTransport } from "../src/engine/app-server-transport";
import type { LiveOptions } from "../src/engine/live-engine";
import type { EngineSnapshot } from "../src/shared/contracts";

const modes: FaultMode[] = (
  process.env.SYNORA_FAULT_CASES ?? "http503,malformed,truncated,stall"
).split(",") as FaultMode[];
if (
  !modes.length ||
  modes.some((m) => !["http503", "malformed", "truncated", "stall"].includes(m))
)
  throw Error("Invalid requested fault case");

test(`Original Core fault recovery (${modes.join(",")}) and owned process crash with real Axiom`, async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-fault-ui-"));
  const workspace = join(dir, "workspace");
  await mkdir(workspace);
  const relay = await axiomFaultRelay(process.env.SYNORA_TEST_ENDPOINT!);
  const options = {
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  const cases: Array<{ name: string; snapshot: EngineSnapshot }> = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const terminal = async (status: string, timeout = 120000) => {
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout })
      .toBe(status);
    await expect
      .poll(() => !!server.service.engine.snapshot().cleanupPending)
      .toBe(false);
    return server.service.engine.snapshot();
  };
  const send = async (text: string) => {
    const previous = server.service.engine.snapshot().turnId;
    await page.getByLabel("Message", { exact: true }).fill(text);
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().turnId, { timeout: 30000 })
      .not.toBe(previous);
  };
  let first: EngineSnapshot | undefined;
  let partial: { id: string; text: string } | undefined;
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("fault-axiom");
    await page
      .getByLabel("Configuration name")
      .fill("Owned fault qualification");
    await page.getByLabel("Configuration endpoint").fill(relay.endpoint);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("fault-axiom");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await nav("Workspace");
    await send("Reply only READY. Do not use tools.");
    first = await terminal("completed");
    cases.push({ name: "actual-baseline", snapshot: first });
    for (const mode of modes) {
      relay.setMode(mode);
      // Only this test-owned engine gets a short deadline for an intentionally
      // idle relay. No application, Core provider or production default changes.
      const owned = server.service.engine as unknown as {
        options: LiveOptions;
        transport?: AppServerTransport;
      };
      const deadline = owned.options.turnDeadlineMs;
      if (mode === "stall") owned.options.turnDeadlineMs = 2000;
      try {
        await send("Reply with the numbers from 1 to 20, without tools.");
        const failed = await terminal("failed", 30000);
        cases.push({ name: mode, snapshot: failed });
        expect(failed.error).toBeTruthy();
        expect(failed.sessionId).toBe(first.sessionId);
        expect(failed.threadId).toBe(first.threadId);
        if (mode === "stall") expect(failed.error?.code).toBe("TURN_DEADLINE");
        if (mode === "truncated") {
          const record = relay.records.at(-1)!;
          expect(record.firstDelta).toBeTruthy();
          expect(record.events).not.toContain("response.completed");
          expect(
            failed.items.some(
              (i) => i.type === "agentMessage" && i.text.length > 0,
            ),
          ).toBe(true);
          partial = failed.items.find(
            (i) => i.type === "agentMessage" && i.text.length > 0,
          ) as typeof partial;
          const stored = server.service.store
            .read()
            .conversations[0].messages.find((m) => m.id === partial!.id);
          expect(stored?.text).toBe(partial!.text);
          expect(stored?.incomplete).toBe(true);
          await expect(
            page.getByText("· Incomplete response", { exact: true }),
          ).toBeVisible();
        }
        await expect.poll(relay.activeCount, { timeout: 5000 }).toBe(0);
        await page.getByLabel("Message", { exact: true }).fill("Retry draft");
        await expect(
          page.getByRole("button", { name: "Send message", exact: true }),
        ).toBeEnabled();
        await page.screenshot({
          path: `test-results/fault-recovery-web/${mode}.png`,
        });
      } finally {
        owned.options.turnDeadlineMs = deadline;
      }
      relay.setMode("normal");
      await send(
        `Reply only RECOVERED_${mode.toUpperCase()}. Do not use tools.`,
      );
      const recovered = await terminal("completed");
      cases.push({ name: `recovered-${mode}`, snapshot: recovered });
      expect(recovered.threadId).toBe(first.threadId);
      expect(recovered.sessionId).toBe(first.sessionId);
      expect(
        recovered.items.some(
          (i) =>
            i.type === "agentMessage" &&
            i.text.includes(`RECOVERED_${mode.toUpperCase()}`),
        ),
      ).toBe(true);
    }
    if (partial) {
      await page.goto("about:blank");
      await server.close();
      server = await startWebService(options);
      await page.goto(server.url);
      await terminal("completed");
      expect(server.service.engine.snapshot().sessionId).toBe(first.sessionId);
      const restored = server.service.store
        .read()
        .conversations[0].messages.find((m) => m.id === partial!.id);
      expect(restored?.text).toBe(partial.text);
      expect(restored?.incomplete).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        page.getByText("· Incomplete response", { exact: true }),
      ).toBeVisible();
      await page
        .getByText("· Incomplete response", { exact: true })
        .scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: "test-results/fault-recovery-web/partial-cold-390.png",
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page
      .getByLabel("Message", { exact: true })
      .fill("Preserve this unsent crash recovery draft.");
    // Deliberately crash only the verified child spawned by this Synora object.
    const owned = server.service.engine as unknown as {
      transport: AppServerTransport;
    };
    const pid = owned.transport.pid!;
    expect(pid).toBeGreaterThan(1);
    expect(await readlink(`/proc/${pid}/cwd`)).toBe(workspace);
    const env = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    expect(env.find((e) => e.startsWith("CODEX_HOME="))).toContain(dir);
    expect(await readlink(`/proc/${pid}/exe`)).toMatch(/codex/);
    process.kill(pid, "SIGKILL");
    await expect
      .poll(() => server.service.engine.snapshot().connection)
      .toBe("disconnected");
    await expect.poll(relay.activeCount).toBe(0);
    await nav("Reconnect");
    await expect
      .poll(() => server.service.engine.snapshot().connection, {
        timeout: 30000,
      })
      .toBe("live");
    expect(server.service.engine.snapshot().threadId).toBe(first.threadId);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Preserve this unsent crash recovery draft.",
    );
    await send("Reply only RECOVERED_CRASH. Do not use tools.");
    const recovered = await terminal("completed");
    cases.push({ name: "recovered-crash", snapshot: recovered });
    expect(recovered.threadId).toBe(first.threadId);
    expect(recovered.sessionId).toBe(first.sessionId);
    await expect(page.locator(".message.assistant").last()).toContainText(
      "RECOVERED_CRASH",
    );
    expect(errors).toEqual([]);
  } finally {
    await mkdir("out/live-evidence", { recursive: true });
    const events = server.service.engine.snapshot();
    await writeFile(
      join(dir, "evidence.json"),
      JSON.stringify(
        {
          dir,
          first,
          cases,
          errors,
          partial,
          modes,
          records: relay.records,
          final: events,
        },
        null,
        2,
      ),
    );
    console.log(`FAULT_EVIDENCE ${dir}/evidence.json`);
    await server.close();
    await relay.close();
  }
});
