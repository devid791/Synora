import readline from "node:readline";
import { spawn } from "node:child_process";
const input = readline.createInterface({ input: process.stdin });
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
input.on("line", (line) => {
  const m = JSON.parse(line);
  if ("result" in m || "error" in m) {
    send({ method: "answered", params: m });
    return;
  }
  if (m.method === "initialize")
    return send({ id: m.id, result: { userAgent: "fixture" } });
  if (m.method === "initialized") return;
  if (m.method === "echo")
    return setTimeout(
      () => send({ id: m.id, result: m.params }),
      m.params.delay ?? 0,
    );
  if (m.method === "fail")
    return send({
      id: m.id,
      error: {
        code: -32000,
        message: "fixture failure",
        data: { tool: "read_file" },
      },
    });
  if (m.method === "never") return;
  if (m.method === "orphan-exit") {
    const child = spawn(process.execPath, ["-e", `
      process.on('SIGTERM', () => {});
      process.send('ready');
      setInterval(() => {}, 1000);
    `], { stdio: ["ignore", process.stdout, process.stderr, "ipc"] });
    child.once("message", () => {
      process.stdout.write(JSON.stringify({ id: m.id, result: child.pid }) + "\n", () => process.exit(0));
    });
    return;
  }
  if (m.method === "exit") return process.exit(3);
  if (m.method === "broken") return process.stdout.write("{invalid}\n");
  if (m.method === "truncated") {
    process.stdout.write('{"id":');
    process.exit(1);
  }
  if (m.method === "oversize") return process.stdout.write("x".repeat(10000));
  if (m.method === "callback") {
    send({
      id: 7,
      method: "approval",
      params: { call_id: "original-call", item_id: "original-item" },
    });
    send({ id: "7", method: "approval", params: { call_id: "second-call" } });
    return send({ id: m.id, result: null });
  }
  if (m.method === "unicode") {
    const bytes = Buffer.from(
      JSON.stringify({ method: "delta", params: { delta: "Hello 🛰️ città" } }) +
        "\n",
    );
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    return send({ id: m.id, result: "done" });
  }
});
