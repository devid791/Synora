import { randomUUID } from "node:crypto";
import { spawn, type IPty } from "node-pty";
import type {
  DesktopEvent,
  TerminalInfo,
  Workspace,
} from "../shared/contracts";

const OUTPUT_LIMIT = 256 * 1024;
interface Entry {
  info: TerminalInfo;
  pty: IPty;
  done: Promise<void>;
  resolve: () => void;
}
export class Terminals {
  private entries = new Map<string, Entry>();
  constructor(private emit: (event: DesktopEvent) => void) {}
  open(workspace: Workspace): TerminalInfo {
    const shell =
      process.platform === "win32"
        ? "powershell.exe"
        : process.platform === "darwin"
          ? "/bin/zsh"
          : "/bin/bash";
    const args = process.platform === "win32" ? ["-NoLogo"] : ["-i"];
    // Keep a usable user shell; credentials are not copied into renderer state or logs.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const pty = spawn(shell, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd: workspace.path,
      env,
      ...(process.platform === "win32" ? { useConpty: true } : {}),
    });
    const info: TerminalInfo = {
      id: randomUUID(),
      workspaceId: workspace.id,
      pid: pty.pid,
      status: "running",
      exitCode: null,
      output: "",
      sequence: 0,
    };
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const entry = { info, pty, done, resolve };
    this.entries.set(info.id, entry);
    pty.onData((data) => {
      info.output = (info.output + data).slice(-OUTPUT_LIMIT);
      this.emit({
        kind: "terminal",
        id: info.id,
        data,
        sequence: ++info.sequence,
      });
    });
    pty.onExit(({ exitCode }) => {
      info.status = "exited";
      info.exitCode = exitCode;
      resolve();
      this.emit({
        kind: "terminal",
        id: info.id,
        data: "",
        sequence: ++info.sequence,
        exitCode,
      });
    });
    return structuredClone(info);
  }
  list() {
    return [...this.entries.values()].map((e) => structuredClone(e.info));
  }
  private get(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Unknown terminal");
    return e;
  }
  write(id: string, input: string) {
    const e = this.get(id);
    if (e.info.status !== "running") throw new Error("Terminal has exited");
    e.pty.write(input);
  }
  resize(id: string, cols: number, rows: number) {
    const e = this.get(id);
    if (e.info.status === "running") e.pty.resize(cols, rows);
  }
  async close(id: string) {
    const e = this.get(id);
    if (e.info.status === "exited") return;
    e.pty.kill();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      e.done,
      new Promise<void>((resolve) => {
        // ConPTY enumerates its owned console processes and drains output
        // before releasing its handles; it has no POSIX signal interface.
        timeout = setTimeout(
          resolve,
          process.platform === "win32" ? 7000 : 800,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (this.get(id).info.status !== "exited") {
      if (process.platform === "win32") process.kill(e.info.pid);
      else e.pty.kill("SIGKILL");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          e.done,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Terminal did not acknowledge exit")),
              1200,
            );
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    }
  }
  async dispose() {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
  }
}
