import type { DesktopAPI } from "../../src/shared/contracts";

/** Explicit read-only result for full-App UI fixtures without native services.
 * No automation operation is permitted or simulated by this fixture. */
export const noControl: DesktopAPI["controlStatus"] = async () => ({
  ok: true,
  value: {
    grant: null, pending: null, activity: [], preview: null,
    available: { browser: false, computer: false, reason: "Controlled UI fixture has no control executor" },
  },
});
