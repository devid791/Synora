import { test, expect } from "@playwright/test";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { controlledMistral } from "./fixtures/mistral-core-upstream";
import { mistralUiWorkflow } from "./fixtures/mistral-ui-workflow";
import { startWebService } from "../src/web/server";
import { sha256File } from "../src/engine/core-runtime";
test("Mistral shared web UI: actual native tool/result, sealed native reasoning history, cold resume, cancellation and credential removal", async ({
  page,
}) => {
  const f = await controlledMistral(),
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
    const result = await mistralUiWorkflow({
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
        await mkdir("out/live-evidence/mistral-ui", { recursive: true });
        await page.screenshot({
          path: "out/live-evidence/mistral-ui/web-390.png",
          fullPage: true,
        });
      },
    });
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/mistral-provider-web.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Shared UI/service and original Core, controlled Mistral Responses; not public inference",
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
