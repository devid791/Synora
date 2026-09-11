import { test, expect } from "@playwright/test";
import { startWebService } from "../src/web/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { qualifyDialogs, qualifyLayout } from "./ui-quality-workflow";

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 900, height: 640 },
  { width: 390, height: 844 },
  { width: 720, height: 480 },
]) {
  test(`Visual UI and keyboard contracts ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    const dir = await mkdtemp(join(tmpdir(), "synora-ui-quality-"));
    const service = await startWebService({
      storePath: join(dir, "state.sqlite"),
      assets: resolve("out/web/ui"),
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.setViewportSize(viewport);
      await page.goto(service.url);
      await qualifyDialogs(page, info);
      await qualifyLayout(page, info);
      expect(errors).toEqual([]);
    } finally {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
