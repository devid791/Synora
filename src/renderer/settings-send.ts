import type { BusySubmission } from "../shared/user-preferences";

/** Only busy keyboard submission uses the modifier override. Form submission
 * and the send button always use the saved default; idle input is unchanged. */
export function busyEnterBehavior(
  preference: BusySubmission["behavior"] = "queue",
  alternate = false,
): BusySubmission["behavior"] {
  return alternate ? (preference === "queue" ? "steer" : "queue") : preference;
}
