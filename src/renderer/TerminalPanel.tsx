import { useEffect, useRef, useState } from "react";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type {
  DesktopAPI,
  DesktopEvent,
  TerminalInfo,
  Workspace,
  Result,
} from "../shared/contracts";
export function TerminalPanel({
  api,
  workspaces,
  report,
}: {
  api: DesktopAPI;
  workspaces: Workspace[];
  report: (e: unknown) => void;
}) {
  const { t, number } = useI18n(messages satisfies Messages);
  const [sessions, setSessions] = useState<TerminalInfo[]>([]),
    [reconnect, setReconnect] = useState(0),
    [selected, setSelected] = useState(""),
    [workspace, setWorkspace] = useState(workspaces[0]?.id ?? "");
  const host = useRef<HTMLDivElement>(null);
  const unwrap = <T,>(r: Result<T>) => {
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const reload = () =>
    api
      .terminalList()
      .then((r) => setSessions(unwrap(r)))
      .catch(report);
  useEffect(() => {
    void reload();
    return api.onEvent((event) => {
      if (event.kind === "resync") {
        void reload();
        setReconnect((v) => v + 1);
      }
      if (event.kind === "terminal" && event.exitCode !== undefined)
        void reload();
    });
  }, []);
  useEffect(() => {
    if (!workspace && workspaces[0]) setWorkspace(workspaces[0].id);
  }, [workspaces]);
  useEffect(() => {
    if (!selected || !host.current) return;
    let disposed = false;
    const terminal = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#101114",
        foreground: "#d9dfe7",
        cursor: "#ada0ff",
      },
      scrollback: 3000,
      convertEol: false,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    // Capture incoming events while the authoritative output snapshot is fetched.
    const pending: Array<Extract<DesktopEvent, { kind: "terminal" }>> = [];
    let ready = false,
      lastSequence = 0;
    const write = (event: Extract<DesktopEvent, { kind: "terminal" }>) => {
      if (event.sequence > lastSequence) {
        terminal.write(event.data);
        lastSequence = event.sequence;
      }
    };
    const off = api.onEvent((event) => {
      if (event.kind === "terminal" && event.id === selected) {
        if (ready) write(event);
        else pending.push(event);
      }
    });
    void api
      .terminalList()
      .then((r) => {
        if (disposed) return;
        const current = unwrap(r).find((s) => s.id === selected);
        terminal.reset();
        terminal.write(current?.output ?? "");
        lastSequence = current?.sequence ?? 0;
        for (const event of pending) write(event);
        ready = true;
        pending.length = 0;
      })
      .catch(report);
    const resize = () => {
      if (disposed || !host.current?.clientWidth) return;
      fit.fit();
      void api
        .terminalResize(selected, terminal.cols, terminal.rows)
        .then(unwrap)
        .catch(report);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    const input = terminal.onData((data) => {
      void api.terminalWrite(selected, data).then(unwrap).catch(report);
    });
    return () => {
      disposed = true;
      off();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [selected, reconnect]);
  const open = async () => {
    try {
      const info = unwrap(await api.terminalOpen(workspace));
      await reload();
      setSelected(info.id);
    } catch (e) {
      report(e);
    }
  };
  return (
    <section className="terminal-panel">
      <div className="toolbar">
        <strong>{t("Local terminal")}</strong>
        <span className="muted">{t("Runs as your OS user · not a model tool")}</span>
        <select
          aria-label={t("Terminal workspace")}
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <button disabled={!workspace} onClick={() => void open()}>
          {t("New terminal")}
        </button>
      </div>
      <div className="tabs">
        {sessions.map((s, i) => (
          <button
            className={s.id === selected ? "selected" : ""}
            key={s.id}
            onClick={() => setSelected(s.id)}
          >
            {t("Terminal {index}", { index: number(i + 1) })}{" "}
            <span className="muted">
              {s.status === "running" ? `PID ${s.pid}` : t("exit {code}", { code: s.exitCode ?? t("Not reported") })}
            </span>
          </button>
        ))}
        {selected && (
          <button
            onClick={() =>
              void api
                .terminalClose(selected)
                .then(unwrap)
                .then(reload)
                .catch(report)
            }
          >
            {t("Stop terminal")}
          </button>
        )}
      </div>
      {selected ? (
        <div ref={host} className="xterm-host" />
      ) : (
        <div className="empty small">
          {t("Choose a workspace and open a real terminal. No commands run automatically.")}
        </div>
      )}
    </section>
  );
}
