import { expect, type Page } from "@playwright/test";
import { BUNDLED_CORE_VERSION } from "../../src/engine/core-runtime";
/** Test-only admission. The dedicated candidate app contains candidate pins;
 * no runtime override or version spoofing is installed into production. */
export async function qualificationRuntime(page: Page) {
  const version = process.env.SYNORA_QUALIFY_CORE_VERSION;
  if (!version) return;
  expect(version).toBe(BUNDLED_CORE_VERSION);
  await page.waitForFunction(() => !!window.synora);
  const actual = await page.evaluate(async version => {
    let status = await window.synora.coreUpdateStatus();
    if (!status.ok) throw Error(status.error.message);
    if (status.value.currentVersion !== version) {
      status = await window.synora.coreUpdateInstall(version);
      if (!status.ok) throw Error(status.error.message);
    }
    const automatic = await window.synora.coreUpdateAutomatic(false);
    if (!automatic.ok) throw Error(automatic.error.message);
    return status.value.currentVersion;
  }, version);
  expect(actual).toBe(version);
}
