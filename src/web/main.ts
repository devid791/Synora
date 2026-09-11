import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { startWebService } from "./server";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SYNORA_WEB_PORT ?? 4319);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid SYNORA_WEB_PORT");
const service = await startWebService({
  storePath: resolve(
    process.env.SYNORA_WEB_DATA_DIR ??
      resolve(homedir(), ".local/share/synora-web"),
    "state.sqlite",
  ),
  assets: resolve(here, "ui"),
  port,
  browserExecutable: process.env.SYNORA_BROWSER_EXECUTABLE,
});
console.log(`Synora local web: ${service.url}`);
console.log(
  "Loopback only. Engine mode follows saved Synora settings; external authentication is not exposed by this service.",
);
const shutdown = () => void service.close().then(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
