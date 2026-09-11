import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let script: string;
test.beforeAll(async () => { script = (await build({ entryPoints: ["tests/fixtures/live-gpu-status-ui.tsx"], bundle: true, write: false,
  platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text; });
test.beforeEach(async ({ page }) => { await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: script }); });
test("A short active turn and approval wait are shown immediately even without a GPU sample", async ({ page }) => {
  await expect(page.locator('[data-gpu-unavailable]')).toHaveText("GPU: live sample unavailable");
  await page.evaluate(() => (window as any).gpu.setStatus("running"));
  await expect(page.locator('[data-axiom-activity]')).toHaveText("Axiom turn active");
  await expect(page.locator('[data-gpu-live]')).toHaveCount(0);
  await page.evaluate(() => (window as any).gpu.setStatus("waiting"));
  await expect(page.locator('[data-axiom-activity]')).toHaveText("Axiom awaiting approval");
  await page.evaluate(() => (window as any).gpu.setStatus("completed"));
  await expect(page.locator('[data-axiom-activity]')).toHaveText("Backend status stale / unavailable");
});
test("Dynamic sensor identities, measured zero, multiple cards, null and stale never fabricate load", async ({ page }) => {
  const make = (id: string, name: string, utilizationPercent: number | null) => ({ id, name, utilizationPercent,
    identity: "device", vendor: "nvidia", pciBusId: "0000:01:00.0", source: "nvidia-smi", memoryUsedBytes: 4 * 1024 ** 3,
    memoryTotalBytes: 8 * 1024 ** 3, temperatureCelsius: 40 });
  const backend = { mode: "live", endpoint: "https://fixture.invalid/v1",
    runtime: { state: "available", observedAt: 10000, data: { generation_busy: false } },
    gpu: { state: "available", observedAt: 10000, data: { sampledAt: 10000, devices: [make("first", "First GPU", 0)] } } };
  await page.evaluate(backend => (window as any).gpu.setBackend(backend), backend);
  await expect(page.locator('[data-axiom-activity]')).toHaveText("Axiom idle");
  await expect(page.locator('[data-gpu-live="first"]')).toContainText("First GPU · 0% · VRAM 4/8 GiB · 40 °C");
  backend.gpu.data.devices = [make("replaced", "Replacement GPU", 86), make("second", "Second GPU", null)];
  await page.evaluate(backend => (window as any).gpu.setBackend(backend), backend);
  await expect(page.locator('[data-gpu-live="first"]')).toHaveCount(0);
  await expect(page.locator('[data-gpu-live="replaced"]')).toContainText("86%");
  await expect(page.locator('[data-gpu-live="second"]')).toContainText("Second GPU · —");
  await page.evaluate(() => (window as any).gpu.setNow(25000));
  await expect(page.locator('[data-gpu-live]')).toHaveCount(0);
  await expect(page.locator('[data-gpu-unavailable]')).toHaveText("GPU: live sample unavailable");
  await page.evaluate(() => { (window as any).gpu.setNow(10000); (window as any).gpu.setError("offline"); });
  await expect(page.locator('[data-gpu-live]')).toHaveCount(0);
});
