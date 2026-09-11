import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { isIP } from "node:net";
import { gpuCollectorHandler } from "../src/main/gpu-collector-server";

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  if (!isIP(config.bindHost) || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw Error("Explicit bind address and unprivileged port required");
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (!credentials) throw Error("Systemd credentials directory required");
  const [cert, key, token] = await Promise.all([
    readFile(config.certificate), readFile(join(credentials, "server.key")), readFile(join(credentials, "token"), "utf8"),
  ]);
  const server = createServer({ cert, key, minVersion: "TLSv1.2", maxHeaderSize: 8192 }, gpuCollectorHandler(token.trim()));
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
  server.maxConnections = 32;
  server.listen(config.port, config.bindHost, () => console.log("Synora read-only GPU collector ready"));
  let closing = false;
  const close = () => { if (closing) return; closing = true; server.close(); server.closeAllConnections(); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
}
void main().catch(() => { console.error("GPU collector startup failed; check private configuration and credentials"); process.exitCode = 1; });
