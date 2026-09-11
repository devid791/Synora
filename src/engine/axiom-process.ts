import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../shared/contracts";
import { AppServerError } from "./app-server-transport";
import { mcpConfiguration, type CoreConfig } from "./mcp-config";
import type {
  Integration,
  AxiomRequestMetrics,
  ModelCapabilities,
} from "../shared/contracts";
import { managedCore } from "./core-runtime";
import { bearerHeaders } from "./axiom-auth";
import {
  createProcessCatalog,
  processResourceCleanup,
} from "./process-catalog";
import {
  axiomContextBridge,
  CONTEXT_TOKEN_ENV,
  CONTEXT_TOKEN_HEADER,
} from "./axiom-context-bridge";

const modelSchema = z.object({
  id: z.string().min(1),
  context_window: z.number().int().positive(),
  context_window_options: z.array(z.number().int().positive()).nonempty(),
  reasoning_efforts: z.array(z.string().min(1)).nonempty(),
  input_modalities: z.array(z.string().min(1)).optional(),
});
export type AxiomModel = z.infer<typeof modelSchema>;
export function axiomEndpoint(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP(S) provider URL without credentials, query or fragment",
    );
  if (!url.pathname.replace(/\/$/, "").endsWith("/codex/v1"))
    throw new Error(
      "Axiom requires its Codex-compatible /codex/v1 endpoint, not legacy /v1",
    );
  return url.href.replace(/\/$/, "");
}
async function catalog(endpoint: string, bearerToken?: string) {
  const response = await fetch(`${axiomEndpoint(endpoint)}/models`, {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
    headers: bearerHeaders(endpoint, bearerToken),
  });
  if (!response.ok)
    throw new AppServerError(
      "CATALOG_HTTP",
      `Axiom model catalog returned HTTP ${response.status}`,
    );
  const length = Number(response.headers.get("content-length"));
  if (length > 2 * 1024 * 1024)
    throw new Error("Axiom model catalog is too large");
  const reader = response.body!.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new Error("Axiom model catalog is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const inventory = z
    .object({
      data: z.array(modelSchema).nonempty(),
      models: z
        .array(z.object({ slug: z.string().min(1) }).passthrough())
        .nonempty(),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  // The native data catalog is the authoritative capability declaration.
  // Retain all Core metadata, translating only explicit supported inputs for
  // this installation-owned catalog. Never alter the upstream production API.
  inventory.models.forEach((model) => {
    const native = inventory.data.find((m) => m.id === model.slug);
    const modalities = native?.input_modalities?.filter(
      (m) => m === "text" || m === "image",
    );
    if (modalities?.length) model.input_modalities = modalities;
  });
  return inventory;
}
export async function axiomModels(
  endpoint: string,
  bearerToken?: string,
): Promise<AxiomModel[]> {
  return (await catalog(endpoint, bearerToken)).data;
}
/** Child-specific environment: never inherit another Codex account or API keys. */
export function appServerEnvironment(
  stateDirectory: string,
  inherited = process.env,
) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    if (inherited[key]) env[key] = inherited[key];
  env.CODEX_HOME = resolve(stateDirectory);
  return env;
}
export async function prepareAxiomProcess(options: {
  runtime?: import("./core-runtime").CoreSelection;
  executable?: string;
  stateDirectory: string;
  cwd: string;
  endpoint: string;
  model: string;
  profile: string;
  context: number | null;
  integrations?: Integration[];
  authorization?: () => Promise<string | undefined>;
  onMetrics?: (value: AxiomRequestMetrics) => void;
}): Promise<{
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  models: ModelCapabilities[];
  args: string[];
  cleanup?: () => Promise<void>;
}> {
  if (options.context === null)
    throw new Error("Axiom requires an advertised explicit context selection");
  const endpoint = axiomEndpoint(options.endpoint);
  const env = appServerEnvironment(options.stateDirectory);
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const cwd = await realpath(options.cwd);
  const executable =
    options.executable ??
    (await (options.runtime?.executable() ??
      managedCore(options.stateDirectory)));
  const result = await promisify(execFile)(executable, ["--version"], {
    env,
    cwd,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (
    result.stdout.trim() !==
    `codex-cli ${options.runtime?.version ?? PROTOCOL_VERSION}`
  )
    throw new Error(
      `This Synora adapter requires qualified Codex ${options.runtime?.version ?? PROTOCOL_VERSION}; the installed executable reports a different version`,
    );
  const bearerToken = await options.authorization?.();
  const inventory = await catalog(endpoint, bearerToken),
    models = inventory.data;
  const model = models.find((m) => m.id === options.model);
  if (!model) throw new Error("Selected model is not advertised by Axiom");
  if (!model.reasoning_efforts.includes(options.profile))
    throw new Error(
      "Selected reasoning profile is not advertised by this model",
    );
  if (!model.context_window_options.includes(options.context))
    throw new Error("Selected context is not advertised by this model");
  if (!inventory.models.some((m) => m.slug === options.model))
    throw new Error("Axiom did not provide Codex metadata for this model");
  const processCatalog = await createProcessCatalog(options.stateDirectory, {
    models: inventory.models,
  });
  let bridge: Awaited<ReturnType<typeof axiomContextBridge>> | undefined;
  const cleanup = processResourceCleanup(
    () => bridge?.close(),
    processCatalog.cleanup,
  );
  try {
    const config: CoreConfig = {
      ...(await mcpConfiguration(
        options.integrations ?? [],
        options.stateDirectory,
      )),
      model_catalog_json: processCatalog.path,
      model: options.model,
      model_provider: "synora_axiom",
      model_reasoning_effort: options.profile,
      model_context_window: options.context,
      "model_providers.synora_axiom.name": "Axiom",
      "model_providers.synora_axiom.base_url": endpoint,
      "model_providers.synora_axiom.wire_api": "responses",
      "model_providers.synora_axiom.requires_openai_auth": false,
      "model_providers.synora_axiom.request_max_retries": 0,
      "model_providers.synora_axiom.stream_max_retries": 0,
      "model_providers.synora_axiom.stream_idle_timeout_ms": 180000,
      "analytics.enabled": false,
      "feedback.enabled": false,
      // Pinned Core capability: handled by Synora's explicit turn-scoped
      // operator approval, never auto-granted and never a sandbox bypass.
      "features.request_permissions_tool": true,
      web_search: "disabled",
    };
    bridge = await axiomContextBridge({
      endpoint,
      bearerToken,
      model: options.model,
      context: options.context,
      onMetrics: options.onMetrics,
    });
    config["model_providers.synora_axiom.base_url"] = bridge.endpoint;
    config[
      `model_providers.synora_axiom.env_http_headers.${CONTEXT_TOKEN_HEADER}`
    ] = CONTEXT_TOKEN_ENV;
    env[CONTEXT_TOKEN_ENV] = bridge.token;
    return {
      executable,
      cwd,
      env,
      models,
      cleanup,
      args: [
        "app-server",
        "--stdio",
        ...Object.entries(config).flatMap(([key, value]) => [
          "-c",
          `${key}=${JSON.stringify(value)}`,
        ]),
      ],
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Axiom preparation and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
