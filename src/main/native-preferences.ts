import type { EngineSnapshot } from "../shared/contracts";
import type { PreferenceCapability } from "../shared/user-preferences";

export type LifecycleNotice =
  | "core-unavailable"
  | "turn-failures"
  | "recovered";
export class LoginItemApprovalRequired extends Error {
  constructor() {
    super(
      "macOS requires approval for Synora in System Settings → General → Login Items. The request is pending; Launch at login is not enabled yet.",
    );
  }
}
export const lifecycleContent: Record<
  LifecycleNotice,
  { title: string; body: string }
> = {
  "core-unavailable": {
    title: "Synora needs attention",
    body: "The local engine is unavailable. Open Synora to check its connection.",
  },
  "turn-failures": {
    title: "Synora needs attention",
    body: "Several operations have failed. Open Synora to review their status.",
  },
  recovered: {
    title: "Synora recovered",
    body: "The affected service is available again. Interrupted work was not automatically replayed.",
  },
};

export interface NativePreferenceHost {
  launchAtLogin?: { read(): boolean; write(enabled: boolean): void };
  setTheme?(theme: "system" | "light" | "dark"): void;
  notify?(kind: LifecycleNotice): void;
}

export function nativePreferenceCapabilities(
  platform: string,
  host: NativePreferenceHost,
) {
  const native = platform === "darwin" || platform === "win32";
  const capability = (present: boolean): PreferenceCapability =>
    native && present
      ? { supported: true }
      : {
          supported: false,
          reason: `No verified native executor is available for ${platform} in this host.`,
        };
  return {
    launchAtLogin: capability(!!host.launchAtLogin),
    systemNotifications: capability(!!host.notify),
  };
}

/** Fixed content only: no prompt, path, provider error, credential or tool output. */
export class EngineNotifications {
  private wasReady = false;
  private connectionFault = false;
  private turnFault = false;
  private failureCount = 0;
  private terminals = new Set<string>();
  private stopped = false;
  constructor(
    private enabled: () => boolean,
    private notify: (kind: LifecycleNotice) => void,
  ) {}
  dispose() {
    this.stopped = true;
  }
  private send(kind: LifecycleNotice) {
    if (this.stopped || !this.enabled()) return false;
    this.notify(kind);
    return true;
  }
  observe(s: EngineSnapshot) {
    if (this.stopped || s.connection === "simulated") return;
    const ready = s.connection === "live" && s.appServer?.phase === "ready";
    if (ready) {
      this.wasReady = true;
      if (this.connectionFault) {
        this.connectionFault = false;
        this.send("recovered");
      }
    } else if (
      s.appServer?.message &&
      (this.wasReady || s.appServer.attempts >= 3)
    ) {
      this.wasReady = false;
      if (!this.connectionFault)
        this.connectionFault = this.send("core-unavailable");
    }
    if (
      !s.turnId ||
      !s.sessionId ||
      !["failed", "completed", "interrupted"].includes(s.status)
    )
      return;
    const key = `${s.sessionId}:${s.turnId}:${s.status}`;
    if (this.terminals.has(key)) return;
    this.terminals.add(key);
    if (this.terminals.size > 512)
      this.terminals.delete(this.terminals.values().next().value!);
    if (s.status === "failed") {
      this.failureCount++;
      if (this.failureCount >= 3 && !this.turnFault && !this.connectionFault)
        this.turnFault = this.send("turn-failures");
    } else if (s.status === "completed") {
      this.failureCount = 0;
      if (this.turnFault) {
        this.turnFault = false;
        this.send("recovered");
      }
    }
  }
}

/** Electron dependencies are injected so tests never touch real OS settings. */
export function loginItemHook(
  app: Pick<Electron.App, "getLoginItemSettings" | "setLoginItemSettings">,
  platform: "darwin" | "win32",
  executable: string,
) {
  const query =
    platform === "win32" ? { path: executable, args: [] as string[] } : {};
  const read = () => {
    const settings = app.getLoginItemSettings(query);
    return (
      settings.openAtLogin &&
      (platform === "win32"
        ? settings.executableWillLaunchAtLogin === true
        : settings.status === "enabled")
    );
  };
  return {
    read,
    write(enabled: boolean) {
      app.setLoginItemSettings({
        ...query,
        openAtLogin: enabled,
        ...(platform === "win32" ? { enabled } : {}),
      });
      if (
        enabled &&
        platform === "darwin" &&
        app.getLoginItemSettings(query).status === "requires-approval"
      )
        throw new LoginItemApprovalRequired();
      if (read() !== enabled)
        throw Error(
          "The operating system did not confirm Launch at login. Review Synora in system Login Items / Startup Apps.",
        );
    },
  };
}
