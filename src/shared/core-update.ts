export interface CoreUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  eligibleVersion: string | null;
  checkedAt: number | null;
  automatic: boolean;
  checking: boolean;
  phase:
    | "idle"
    | "preparing"
    | "snapshotting"
    | "validating"
    | "switching"
    | "failed";
  message: string;
  checks: string[];
  previousVersion: string | null;
  recoveryId: string | null;
  disabledReason: string | null;
}
