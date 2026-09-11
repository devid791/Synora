import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { configSchema, type Integration } from "../shared/contracts";
import { integrationServerName } from "../shared/integration-runtime";
import { unpackNativeWeb } from "./native-web-runtime";

export type CoreConfig = Record<string, string | number | boolean | string[]>;
/** Only a trusted host/runtime path; the renderer cannot supply an executable. */
async function webBinary(stateDirectory?: string) {
  const runtime = process as NodeJS.Process & {
    resourcesPath?: string;
    defaultApp?: boolean;
  };
  const resources = runtime.defaultApp ? undefined : runtime.resourcesPath;
  const directory = resources
    ? join(resources, "native", `${process.platform}-${process.arch}`)
    : resolve("out/native", `${process.platform}-${process.arch}`);
  let selected = process.env.SYNORA_WEB_MCP_BINARY;
  if (!selected && resources) {
    if (!stateDirectory)
      throw new Error(
        "Packaged web execution requires an app-owned state directory",
      );
    selected = await unpackNativeWeb(directory, stateDirectory);
  }
  const path = await realpath(
    selected ||
      join(
        directory,
        process.platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp",
      ),
  );
  await access(path, constants.X_OK);
  const manifest = JSON.parse(
    await readFile(join(dirname(path), "web-mcp-manifest.json"), "utf8"),
  );
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (
    manifest.sha256 !== digest ||
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch
  )
    throw new Error(
      "The native web executor does not match its platform/hash receipt",
    );
  return path;
}
export async function mcpConfiguration(
  values: Integration[],
  stateDirectory?: string,
): Promise<CoreConfig> {
  // Core's default keyring namespace is not isolated by CODEX_HOME. Keep OAuth
  // in Synora's private Core home instead; never touch another Codex account.
  const config: CoreConfig = { mcp_oauth_credentials_store: "file" };
  for (const value of values) {
    const v = configSchema.parse(value);
    if (!v.enabled || !v.executor || v.executor === "configuration-only")
      continue;
    if (v.auth !== "none" && !(v.executor === "http-mcp" && v.auth === "oauth"))
      throw new Error(
        `${v.name}: authenticate this executor before mounting it`,
      );
    const prefix = `mcp_servers.${integrationServerName(v.id)}`;
    config[`${prefix}.enabled`] = true;
    config[`${prefix}.startup_timeout_sec`] = 10;
    config[`${prefix}.tool_timeout_sec`] = 35;
    if (v.executor === "searxng") {
      config[`${prefix}.command`] = await webBinary(stateDirectory);
      config[`${prefix}.args`] = [];
      config[`${prefix}.enabled_tools`] = ["web_search", "web_fetch"];
      config[`${prefix}.env.AXIOM_SEARCH_URL`] = v.endpoint;
      config[`${prefix}.env.AXIOM_WEB_TIMEOUT_MS`] = "15000";
      config[`${prefix}.env.AXIOM_WEB_MAX_RESPONSE_BYTES`] = "1048576";
    } else config[`${prefix}.url`] = v.endpoint;
  }
  return config;
}
