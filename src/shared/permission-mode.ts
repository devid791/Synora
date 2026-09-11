import { z } from "zod";
export const permissionModeSchema = z.enum(["ask", "auto-review", "full"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export function permissionContract(mode: PermissionMode = "ask") {
  return mode === "full"
    ? {
        approvalPolicy: "never" as const,
        approvalsReviewer: "user" as const,
        sandbox: "danger-full-access" as const,
        sandboxType: "dangerFullAccess" as const,
      }
    : {
        approvalPolicy: "on-request" as const,
        approvalsReviewer:
          mode === "auto-review" ? ("auto_review" as const) : ("user" as const),
        sandbox: "workspace-write" as const,
        sandboxType: "workspaceWrite" as const,
      };
}
