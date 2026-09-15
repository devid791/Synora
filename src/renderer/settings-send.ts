import type { BusySubmission } from "../shared/user-preferences";

/** Only busy keyboard submission uses the modifier override. Form submission
 * uses the saved default; explicit busy action buttons name their behavior.
 * Idle input is unchanged. */
export function busyEnterBehavior(
  preference: BusySubmission["behavior"] = "queue",
  alternate = false,
): BusySubmission["behavior"] {
  return alternate ? (preference === "queue" ? "steer" : "queue") : preference;
}
