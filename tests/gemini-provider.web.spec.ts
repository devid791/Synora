import { test, expect } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { controlledGemini } from "./fixtures/gemini-upstream";
import { geminiUiWorkflow } from "./fixtures/gemini-ui-workflow";
import { startWebService } from "../src/web/server";
import { sha256File } from "../src/engine/core-runtime";
test("Gemini shared web UI: actual native tool/result, signed history, cold resume, cancellation and credential removal", async ({
  page,
}) => {
  const f = await controlledGemini(),
    old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = f.wrapper;
  const options = {
    storePath: join(f.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.url);
    const result = await geminiUiWorkflow({
      fixture: f,
      page: () => page,
      snapshot: async () => server.service.engine.snapshot(),
      addWorkspace: async () => {
        await page
          .getByRole("button", { name: "Add workspace", exact: true })
          .click();
        await page.getByLabel("Service folder").fill(f.workspace);
        await page
          .getByRole("button", { name: "Open folder", exact: true })
          .click();
      },
      restart: async () => {
        await page.goto("about:blank");
        await server.close();
        server = await startWebService(options);
        await page.goto(server.url);
      },
      capture: async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .getByRole("button", { name: "Remove token", exact: true })
          .scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mkdir("out/live-evidence/gemini-ui", { recursive: true });
        await page.screenshot({
          path: "out/live-evidence/gemini-ui/web-390.png",
          fullPage: true,
        });
      },
    });
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/gemini-provider-web.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Shared UI/service and original Core, controlled native Gemini; not public inference",
          coreSha256: await sha256File(f.core),
          ...result,
          uiErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
    await f.close();
    if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = old;
  }
});
