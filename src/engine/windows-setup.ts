import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { appServerEnvironment } from "./axiom-process";
import { managedCore, selectedCoreVersion } from "./core-runtime";
import {
  AppServerTransport,
  type TransportOptions,
} from "./app-server-transport";
import { parseNotification, parseResponse } from "./protocol-validation";
import { type NativeToolSetup } from "../shared/contracts";

type Options = {
  runtime?: import("./core-runtime").CoreSelection;
  stateDirectory: string;
  cwd: string;
  mode?: "elevated" | "unelevated";
  executable?: string;
  // Dependency injection for deterministic protocol/timeout tests, never IPC.
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  transport?: (
    options: TransportOptions,
  ) => Pick<AppServerTransport, "request" | "notify" | "respond" | "close">;
};

/** No model request. Setup is only invoked by an explicit operator operation. */
export async function nativeToolSetup(
  options: Options,
): Promise<NativeToolSetup> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    if (options.mode)
      throw new Error(
        "Windows sandbox setup is only available on a Windows service host",
      );
    return { platform, status: "notApplicable" };
  }
  await mkdir(options.stateDirectory, { recursive: true });
  const cwd = await realpath(options.cwd);
  const executable =
    options.executable ??
    (await (options.runtime?.executable() ??
      managedCore(options.stateDirectory)));
  const env = appServerEnvironment(options.stateDirectory);
  if (!options.transport) {
    const version = await promisify(execFile)(executable, ["--version"], {
      cwd,
      env,
      windowsHide: true,
      timeout: 10000,
    });
    if (
      version.stdout.trim() !==
      `codex-cli ${selectedCoreVersion(options)}`
    )
      throw new Error(`Native setup requires pinned Core ${selectedCoreVersion(options)}`);
  }
  let completed!: (v: { success: boolean; error: string | null }) => void;
  const completion = new Promise<{ success: boolean; error: string | null }>(
    (resolve) => {
      completed = resolve;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const create =
    options.transport ?? ((o: TransportOptions) => new AppServerTransport(o));
  const transport = create({
    executable,
    cwd,
    env,
    args: [
      "app-server",
      "--stdio",
      "-c",
      "analytics.enabled=false",
      "-c",
      "feedback.enabled=false",
    ],
    onNotification: (raw) => {
      try {
        const message = parseNotification(raw);
        if (message.method === "windowsSandbox/setupCompleted") {
          if (message.params.mode !== options.mode)
            completed({
              success: false,
              error: "Core completed a different Windows setup mode",
            });
          else completed(message.params);
        }
      } catch (e) {
        completed({ success: false, error: String(e) });
      }
    },
    onRequest: (request) =>
      transport.respond(request.id, {
        error: {
          code: -32601,
          message: "This setup connection does not execute model tool requests",
        },
      }),
    onClose: (error) => completed({ success: false, error: error.message }),
  });
  try {
    await transport.request("initialize", {
      clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    transport.notify("initialized");
    if (!options.mode)
      return {
        platform,
        ...parseResponse(
          "windowsReadiness",
          await transport.request("windowsSandbox/readiness", {}),
        ),
      };
    const started = parseResponse(
      "windowsSetup",
      await transport.request("windowsSandbox/setupStart", {
        mode: options.mode,
        cwd,
      }),
    );
    if (!started.started)
      throw new Error("Core did not start Windows sandbox setup");
    const result = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Windows sandbox setup has not completed. Check the Windows setup prompt and recheck status; no ready state was assumed.",
              ),
            ),
          // Original elevated Core setup traverses existing build/profile
          // trees to apply sandbox ACLs. The verified builder took ~5 minutes;
          // an inference-sized 2-minute deadline cut off its completion event.
          options.timeoutMs ?? 600000,
        );
      }),
    ]);
    if (!result.success)
      throw new Error(result.error ?? "Windows sandbox setup failed");
    // Successful setup persists Core config. Recheck through a fresh process;
    // the process that performed setup may still hold the previous config.
    await transport.close();
    const status = await nativeToolSetup({ ...options, mode: undefined });
    if (status.status !== "ready")
      throw new Error(
        `Windows setup completed but readiness is ${status.status}`,
      );
    return status;
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}
