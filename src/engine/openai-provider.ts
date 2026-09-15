import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import {
  appServerEnvironment,
  type prepareAxiomProcess,
} from "./axiom-process";
import { managedCore, selectedCoreVersion } from "./core-runtime";
import { mcpConfiguration } from "./mcp-config";
import { AppServerTransport } from "./app-server-transport";
import { parseResponse } from "./protocol-validation";
import {
  OPENAI_ENDPOINT,
  type ModelCapabilities,
} from "../shared/contracts";
import type { ModelListResponse } from "../protocol/codex-0.153.4/v2/ModelListResponse";

export { OPENAI_ENDPOINT } from "../shared/contracts";
export async function readOpenAiModels(
  transport: Pick<AppServerTransport, "request">,
): Promise<ModelCapabilities[]> {
  const account = parseResponse(
    "account",
    await transport.request("account/read", { refreshToken: false }),
  );
  if (!account.account || !["apiKey", "chatgpt"].includes(account.account.type))
    throw new Error(
      "Sign in to the Synora OpenAI / ChatGPT account before selecting this provider",
    );
  const models: ModelCapabilities[] = [],
    cursors = new Set<string>(),
    ids = new Set<string>();
  let cursor: string | null = null;
  const deadline = Date.now() + 60000;
  do {
    if (Date.now() >= deadline)
      throw new Error("Core model catalog pagination exceeded its deadline");
    const page: ModelListResponse = parseResponse(
      "modelList",
      await transport.request(
        "model/list",
        { includeHidden: false, limit: 100, cursor },
        Math.min(30000, deadline - Date.now()),
      ),
    );
    for (const model of page.data) {
      if (model.hidden) continue;
      if (!model.model || ids.has(model.model))
        throw new Error(
          "Core returned an empty or ambiguous inference model identity",
        );
      ids.add(model.model);
      const efforts = model.supportedReasoningEfforts.map(
        (e) => e.reasoningEffort,
      );
      if (new Set(efforts).size !== efforts.length || efforts.some((e) => !e))
        throw new Error("Core returned ambiguous reasoning options");
      if (efforts.length && !efforts.includes(model.defaultReasoningEffort))
        throw new Error(
          "Core model default is not a supported reasoning effort",
        );
      models.push({
        id: model.model,
        context_window: null,
        context_window_options: [],
        reasoning_efforts: efforts,
        ...(efforts.length
          ? { default_reasoning_effort: model.defaultReasoningEffort }
          : {}),
        coreModel: model,
      });
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (cursors.has(cursor))
        throw new Error("Core repeated a model catalog cursor");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  if (!models.length)
    throw new Error("Core returned no picker-visible models for this account");
  return models;
}
export function validateOpenAiSelection(
  models: ModelCapabilities[],
  model: string,
  effort?: string,
) {
  const selected = models.find((m) => m.id === model);
  if (!selected)
    throw new Error(
      "Selected model is not advertised by the current Core account catalog",
    );
  if (effort && !selected.reasoning_efforts.includes(effort))
    throw new Error(
      "Selected reasoning effort is not advertised by this Core model",
    );
  return selected;
}
export const prepareOpenAiProcess: typeof prepareAxiomProcess = async (
  options,
) => {
  if (
    options.endpoint !== OPENAI_ENDPOINT ||
    options.context !== null ||
    options.authorization
  )
    throw new Error(
      "OpenAI requires original Core routes, account-managed credentials and Core-managed context",
    );
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const cwd = await realpath(options.cwd),
    env = appServerEnvironment(options.stateDirectory);
  const executable =
    options.executable ??
    (await (options.runtime?.executable() ??
      managedCore(options.stateDirectory)));
  const version = await promisify(execFile)(executable, ["--version"], {
    env,
    cwd,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (
    version.stdout.trim() !==
    `codex-cli ${selectedCoreVersion(options)}`
  )
    throw new Error("Pinned Core version mismatch");
  const config = {
    ...(await mcpConfiguration(
      options.integrations ?? [],
      options.stateDirectory,
    )),
    model_provider: "openai",
    ...(options.model ? { model: options.model } : {}),
    cli_auth_credentials_store: "file",
    // Core filters an empty override to None and selects the original API-key
    // or ChatGPT route from its auth mode. Do not inherit a workspace redirect.
    openai_base_url: "",
    ...(options.profile ? { model_reasoning_effort: options.profile } : {}),
    "analytics.enabled": false,
    "feedback.enabled": false,
    "features.request_permissions_tool": true,
  };
  return {
    executable,
    cwd,
    env,
    models: [],
    args: [
      "app-server",
      "--stdio",
      ...Object.entries(config).flatMap(([k, v]) => [
        "-c",
        `${k}=${JSON.stringify(v)}`,
      ]),
    ],
  };
};

/** Metadata-only, original Core account connection. No custom model routing. */
export async function openAiModels(options: {
  runtime?: import("./core-runtime").CoreSelection;
  stateDirectory: string;
  executable?: string;
}) {
  const prepared = await prepareOpenAiProcess({
    ...options,
    cwd: options.stateDirectory,
    endpoint: OPENAI_ENDPOINT,
    model: "",
    profile: "",
    context: null,
  });
  const transport = new AppServerTransport({
    ...prepared,
    onNotification: () => {},
    onRequest: (r) =>
      transport.respond(r.id, {
        error: {
          code: -32601,
          message: "Catalog connection cannot execute model tools",
        },
      }),
    onClose: () => {},
  });
  try {
    await transport.request("initialize", {
      clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");
    return await readOpenAiModels(transport);
  } finally {
    await transport.close();
  }
}
