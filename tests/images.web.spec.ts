import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomInt, createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { startWebService } from "../src/web/server";

test("Actual original Core/Axiom image input, durable draft, visual answer and cold image history", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-vision-ui-")),
    workspace = join(dir, "workspace");
  await mkdir(workspace);
  const [color, hex] = [
    ["BLUE", "#0044ff"],
    ["RED", "#ee0000"],
    ["GREEN", "#00bb22"],
  ][randomInt(3)];
  const png = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384"><rect width="512" height="384" fill="${hex}"/><circle cx="256" cy="192" r="40" fill="#fff"/></svg>`,
  )
    .render()
    .asPng();
  const expectedHash = createHash("sha256").update(png).digest("hex");
  const options = {
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("image-axiom");
    await page.getByLabel("Configuration name").fill("Image qualification");
    await page
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_ENDPOINT!);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("image-axiom");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await nav("Workspace");
    await page
      .getByLabel("Attach image files")
      .setInputFiles({ name: "scene.png", mimeType: "image/png", buffer: png });
    const draft = page.getByLabel("Draft images");
    await expect(draft.getByRole("img", { name: "scene.png" })).toBeVisible();
    const initial = server.service.store.read().conversations[0];
    const image = initial.attachments![0];
    expect(image.sha256).toBe(expectedHash);
    expect(JSON.stringify(initial)).not.toContain(png.toString("base64"));
    await page.reload();
    await expect(draft.getByRole("img", { name: "scene.png" })).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Look only at the attached image. What color covers the largest area? Reply with just the color name in English. Do not use tools.",
      );
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 120000 })
      .toBe("completed");
    const completed = server.service.engine.snapshot(),
      conversation = server.service.store.read().conversations[0];
    await expect(page.locator(".message.assistant").last()).toContainText(
      new RegExp(color, "i"),
    );
    expect(
      completed.items.some(
        (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
      ),
    ).toBe(false);
    expect(conversation.draftImageIds).toEqual([]);
    expect(
      conversation.messages.find((m) => m.role === "user")?.imageIds,
    ).toEqual([image.id]);
    await expect(
      page.locator(".message.user").getByRole("img", { name: "scene.png" }),
    ).toBeVisible();
    expect(completed.firstDeltaAt).toBeLessThan(completed.completedAt!);
    expect(completed.backendRequests?.length).toBeGreaterThan(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".message.user img")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/images-web/actual-image-390.png",
    });
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 30000 })
      .toBe("completed");
    const restored = server.service.engine.snapshot();
    expect(restored.sessionId).toBe(completed.sessionId);
    expect(restored.threadId).toBe(completed.threadId);
    expect(
      server.service.store
        .read()
        .conversations[0].messages.find((m) => m.role === "user")?.imageIds,
    ).toEqual([image.id]);
    await expect(page.locator(".message.user img")).toHaveCount(1);
    await expect(page.locator(".message.user img")).toBeVisible();
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/image-actual.json",
      JSON.stringify(
        {
          passed: true,
          dir,
          image,
          color,
          completed,
          restored,
          errors,
          scope:
            "Actual Axiom visual answer via original Core and shared web UI; no public provider or packaged-platform claim",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/image-actual-failure.json",
      JSON.stringify(
        {
          dir,
          color,
          error: String(error),
          snapshot: server.service.engine.snapshot(),
          state: server.service.store.read(),
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
