// Controlled Responses upstream for original Core qualification. No public
// model/account traffic: the caller must run with only loopback networking.
import { expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { createServer } from "node:http";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertControlledNetwork } from "./controlled-network";
import { managedCore, sha256File } from "../../src/engine/core-runtime";
import { controlledCoreLauncher } from "./controlled-core-launcher";
import {
  ResponsesToolCodec,
  ResponsesToolStream,
} from "../../src/engine/responses-tool-codec";

export async function controlledOpenAi(
  options: {
    jsonFunctions?: boolean;
    xai?: boolean;
    openrouter?: boolean;
    openrouterNoReasoning?: boolean;
    deepseek?: boolean;
    compatible?: boolean;
  } = {},
) {
  const translated =
    !!options.xai ||
    !!options.openrouter ||
    !!options.deepseek ||
    !!options.compatible;
  await assertControlledNetwork();
  const directory = await mkdtemp(join(tmpdir(), "synora-openai-provider-"));
  await mkdir(join(directory, "workspace"));
  const workspace = await realpath(join(directory, "workspace"));
  await writeFile(
    join(workspace, "provider-check.txt"),
    "SYNORA_PROVIDER_FILE_OK\n",
  );
  let dataRoot = join(directory, "state");
  let accountHome = join(dataRoot, "accounts", "openai");
  let core: string;
  if (process.platform === "win32") {
    const prepared = resolve(process.env.SYNORA_TEST_PREPARED_WINDOWS_QA ?? "");
    expect(prepared).toMatch(
      /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
    );
    dataRoot = join(prepared, "state");
    const binding = JSON.parse(
      await readFile(
        join(dataRoot, "app-server", ".windows-home.json"),
        "utf8",
      ),
    );
    expect(binding.relative).toBe("app-server/native-axiom");
    accountHome = join(dataRoot, binding.relative);
    core = join(
      dataRoot,
      "core-runtime",
      "0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a",
      "bin",
      "codex.exe",
    );
    expect(await sha256File(core)).toBe(
      "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b",
    );
    // Never provision another sandbox, or replace an existing account.
    await expect(
      readFile(join(accountHome, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } else core = await managedCore(join(directory, "payload"));
  const requests: {
    path: string;
    body: any;
    authorized: boolean;
    completed?: boolean;
    codecCounts?: ReturnType<() => ResponsesToolCodec["counts"]>;
    wireBody?: any;
  }[] = [];
  const errors: string[] = [];
  const key = "sk-SYNORA-LOOPBACK-ONLY-DISPOSABLE-NOT-A-CREDENTIAL";
  let commandIssued = false;
  const state: {
    toolResult?: any;
    hold: boolean;
    heldRequests: number;
    cancelledStreams: number;
  } = { hold: false, heldRequests: 0, cancelledStreams: 0 };
  const upstream = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      let bytes: Buffer = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd")
        bytes = zstdDecompressSync(bytes);
      else if (req.headers["content-encoding"] === "gzip")
        bytes = gunzipSync(bytes);
      const body = bytes.length ? JSON.parse(bytes.toString("utf8")) : null;
      if (
        options.compatible &&
        req.method === "GET" &&
        req.url === "/v1/models"
      ) {
        expect(req.headers.authorization).toBe(`Bearer ${key}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "fixture/compatible-model" },
              { id: "fixture-unknown-future-model" },
            ],
          }),
        );
        return;
      }
      if (
        options.deepseek &&
        req.method === "GET" &&
        req.url === "/v1/models"
      ) {
        expect(req.headers.authorization).toBe(`Bearer ${key}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: ["deepseek-v4-flash", "fixture-unknown-future-model"].map(
              (id) => ({ id, object: "model", owned_by: "deepseek" }),
            ),
          }),
        );
        return;
      }
      if (
        options.xai &&
        req.method === "GET" &&
        req.url === "/v1/language-models"
      ) {
        expect(req.headers.authorization).toBe(`Bearer ${key}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                id: "grok-4.6",
                aliases: [],
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              {
                id: "unqualified-fixture-model",
                aliases: [],
                input_modalities: ["text"],
                output_modalities: ["text"],
              },
            ],
          }),
        );
        return;
      }
      if (
        options.openrouter &&
        req.method === "GET" &&
        req.url === "/v1/models/user"
      ) {
        expect(req.headers.authorization).toBe(`Bearer ${key}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "fixture/router-model",
                name: "Controlled Router Model",
                context_length: 131072,
                architecture: {
                  input_modalities: ["text", "image"],
                  output_modalities: ["text"],
                },
                supported_parameters: options.openrouterNoReasoning
                  ? ["tools"]
                  : ["tools", "reasoning"],
                reasoning: options.openrouterNoReasoning
                  ? null
                  : {
                      mandatory: false,
                      supported_efforts: ["high", "medium", "low"],
                      default_enabled: true,
                      default_effort: "high",
                    },
              },
              {
                id: "fixture/no-tools",
                context_length: 8192,
                architecture: {
                  input_modalities: ["text"],
                  output_modalities: ["text"],
                },
                supported_parameters: [],
              },
            ],
            links: { next: null },
            total_count: 2,
          }),
        );
        return;
      }
      if (options.openrouter && body) {
        expect(body.provider).toEqual({ require_parameters: true });
        expect(body.model).toBe("fixture/router-model");
      }
      if (options.jsonFunctions && body) {
        await mkdir("out/live-evidence", { recursive: true });
        await writeFile(
          "out/live-evidence/responses-tool-codec-original-catalog.json",
          JSON.stringify(body, null, 2),
        );
      }
      const codec =
        options.jsonFunctions && body ? new ResponsesToolCodec() : undefined;
      const wireBody: any = translated ? body : codec?.request(body);
      const jsonFunctions = !!codec || translated;
      const record = {
        path: req.url!,
        body,
        authorized: req.headers.authorization === `Bearer ${key}`,
        completed: false,
        ...(codec
          ? { codecCounts: codec.counts, wireBody }
          : translated
            ? { wireBody }
            : {}),
      };
      requests.push(record);
      // Core's original 426 response handling selects HTTP/SSE fallback.
      if (req.method === "GET" && req.url === "/v1/responses") {
        res.writeHead(426);
        res.end("{}");
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses") {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      expect(record.authorized).toBe(true);
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty("context_window");
      if (options.compatible) {
        expect(body.model).toBe("fixture/compatible-model");
        expect(body.store).toBe(false);
        expect(body).not.toHaveProperty("provider");
        expect(body.reasoning.effort).toBe("high");
      }
      if (options.deepseek) {
        expect(body.model).toBe("deepseek-v4-flash");
        expect(body).not.toHaveProperty("store");
        expect(body).not.toHaveProperty("include");
        expect(body).not.toHaveProperty("parallel_tool_calls");
        expect(body.input.some((v: any) => v.role === "developer")).toBe(false);
        if (commandIssued) {
          expect(
            body.input.some(
              (v: any) =>
                v.type === "reasoning" &&
                v.content?.some(
                  (p: any) =>
                    p.type === "reasoning_text" &&
                    p.text === "Controlled fixture reasoning retained exactly.",
                ),
            ),
          ).toBe(true);
        }
      }
      if (translated) {
        expect(body).not.toHaveProperty("client_metadata");
        expect(
          body.input.every(
            (v: any) =>
              v.type !== "additional_tools" &&
              !("internal_chat_message_metadata_passthrough" in v),
          ),
        ).toBe(true);
        expect(body.tools.every((t: any) => t.type === "function")).toBe(true);
      }
      const id = `fixture-response-${requests.length}`,
        itemId = `fixture-item-${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const stream = codec ? new ResponsesToolStream(codec) : undefined;
      if (stream) {
        stream.on("error", (e) => {
          errors.push(String(e));
          res.destroy();
        });
        stream.pipe(res);
        res.once("close", () => stream.destroy());
      }
      let sequence = 0;
      const reasoning = {
        type: "reasoning",
        id: `${id}-reasoning`,
        content: [
          {
            type: "reasoning_text",
            text: "Controlled fixture reasoning retained exactly.",
          },
        ],
      };
      const writeEvent = (type: string, data: any = {}) => {
        const bytes = Buffer.from(
          `event: ${type}\ndata: ${JSON.stringify({ type, ...data, ...(options.deepseek ? { sequence_number: sequence++ } : {}) })}\n\n`,
        );
        if (stream) {
          // Exercise fragmented UTF-8 SSE over the actual Core HTTP connection.
          for (let i = 0; i < bytes.length; i += 11)
            stream.write(bytes.subarray(i, i + 11));
        } else res.write(bytes);
      };
      const send = (type: string, data: any = {}) => {
        if (options.deepseek) {
          if (data.output_index !== undefined)
            data = { ...data, output_index: data.output_index + 1 };
          if (type === "response.completed")
            data = {
              ...data,
              response: {
                ...data.response,
                output: [reasoning, ...data.response.output],
              },
            };
        }
        writeEvent(type, data);
        if (
          options.deepseek &&
          type === "response.in_progress" &&
          !state.hold
        ) {
          writeEvent("response.output_item.added", {
            output_index: 0,
            item: { ...reasoning, content: [] },
          });
          writeEvent("response.content_part.added", {
            output_index: 0,
            item_id: reasoning.id,
            content_index: 0,
            part: { type: "reasoning_text", text: "" },
          });
          writeEvent("response.reasoning_text.delta", {
            output_index: 0,
            item_id: reasoning.id,
            content_index: 0,
            delta: reasoning.content[0].text,
          });
          writeEvent("response.reasoning_text.done", {
            output_index: 0,
            item_id: reasoning.id,
            content_index: 0,
            text: reasoning.content[0].text,
          });
          writeEvent("response.content_part.done", {
            output_index: 0,
            item_id: reasoning.id,
            content_index: 0,
            part: reasoning.content[0],
          });
          writeEvent("response.output_item.done", {
            output_index: 0,
            item: reasoning,
          });
        }
      };
      const response = {
        id,
        object: "response",
        status: "in_progress",
        model: body.model,
        output: [],
      };
      send("response.created", { response });
      send("response.in_progress", { response });
      if (state.hold) {
        state.heldRequests++;
        res.once("close", () => state.cancelledStreams++);
        return;
      }
      if (!commandIssued) {
        const mounted = body.input
          .filter((x: any) => x.type === "additional_tools")
          .flatMap((x: any) => x.tools);
        const functions = mounted.find(
          (x: any) => x.type === "namespace" && x.name === "functions",
        );
        if (!translated)
          expect(
            functions.tools.some(
              (t: any) => t.name === "exec" && t.type === "custom",
            ),
          ).toBe(true);
        expect(JSON.stringify(translated ? body.tools : mounted)).toContain(
          "exec_command",
        );
        commandIssued = true;
        const originalCall = {
          type: "custom_tool_call",
          id: itemId,
          call_id: "original-call-provider-read",
          namespace: "functions",
          name: "exec",
          input: `text(await tools.exec_command(${JSON.stringify({ cmd: process.platform === "win32" ? "Get-Content -Raw -LiteralPath provider-check.txt" : "cat provider-check.txt", workdir: workspace, max_output_tokens: 200 })}));`,
        };
        // The controlled upstream returns only ordinary JSON function calls.
        // The boundary, not the fixture executor, restores Core's custom input.
        const mapped = wireBody?.tools.find(
          (t: any) =>
            (t.description?.startsWith(
              "Original Core tool: functions.exec\n",
            ) ||
              (translated &&
                t.description?.startsWith("Original Core tool: exec\n"))) &&
            t.parameters?.required?.length === 1 &&
            t.parameters.required[0] === "input",
        );
        if (jsonFunctions) {
          expect(mapped).toBeTruthy();
          expect(wireBody.tools.every((t: any) => t.type === "function")).toBe(
            true,
          );
          expect(
            wireBody.input.some((v: any) => v.type === "additional_tools"),
          ).toBe(false);
        }
        const call: any = jsonFunctions
          ? {
              type: "function_call",
              id: originalCall.id,
              call_id: originalCall.call_id,
              name: mapped.name,
              arguments: JSON.stringify({ input: originalCall.input }),
            }
          : originalCall;
        send("response.output_item.added", {
          output_index: 0,
          item: {
            ...call,
            ...(jsonFunctions ? { arguments: "" } : { input: "" }),
          },
        });
        const argumentText = jsonFunctions ? call.arguments : call.input;
        // Include escape/prefix boundaries, not only one fully buffered frame.
        for (let i = 0; i < argumentText.length; i += 7)
          send(
            jsonFunctions
              ? "response.function_call_arguments.delta"
              : "response.custom_tool_call_input.delta",
            {
              item_id: itemId,
              output_index: 0,
              delta: argumentText.slice(i, i + 7),
            },
          );
        send(
          jsonFunctions
            ? "response.function_call_arguments.done"
            : "response.custom_tool_call_input.done",
          {
            item_id: itemId,
            output_index: 0,
            ...(jsonFunctions
              ? { arguments: call.arguments }
              : { input: call.input }),
          },
        );
        send("response.output_item.done", { output_index: 0, item: call });
        send("response.completed", {
          response: {
            ...response,
            status: "completed",
            output: [call],
            usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
          },
        });
      } else {
        const result = body.input.find(
          (x: any) =>
            x.type ===
              (translated
                ? "function_call_output"
                : "custom_tool_call_output") &&
            x.call_id === "original-call-provider-read",
        );
        if (!state.toolResult) {
          expect(result).toBeTruthy();
          expect(JSON.stringify(result)).toContain("SYNORA_PROVIDER_FILE_OK");
          state.toolResult = result;
        }
        if (codec) {
          const wireResult = wireBody.input.find(
            (x: any) =>
              x.type === "function_call_output" &&
              x.call_id === "original-call-provider-read",
          );
          expect(wireResult).toBeTruthy();
          expect(wireResult.output).toEqual(result.output);
          expect(
            wireBody.input.some(
              (x: any) => x.type === "custom_tool_call_output",
            ),
          ).toBe(false);
        }
        const content = {
          type: "output_text",
          text: "SYNORA_PROVIDER_OK",
          annotations: [],
        };
        const item = {
          type: "message",
          id: itemId,
          role: "assistant",
          status: "in_progress",
          content: [],
        };
        send("response.output_item.added", { output_index: 0, item });
        send("response.content_part.added", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { ...content, text: "" },
        });
        send("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: "SYNORA_",
        });
        await new Promise((r) => setTimeout(r, 150));
        send("response.output_text.delta", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta: "PROVIDER_OK",
        });
        send("response.output_text.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: content.text,
        });
        send("response.content_part.done", {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: content,
        });
        const done = { ...item, status: "completed", content: [content] };
        send("response.output_item.done", { output_index: 0, item: done });
        send("response.completed", {
          response: {
            ...response,
            status: "completed",
            output: [done],
            usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
          },
        });
      }
      record.completed = true;
      if (stream) stream.end();
      else res.end();
    } catch (error) {
      errors.push(String(error));
      res.destroy();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  // Trusted test wrapper only. Production prepareOpenAiProcess always resets
  // openai_base_url to Core's original auth-specific default.
  let wrapper: string;
  try {
    wrapper = await controlledCoreLauncher(
      directory,
      core,
      translated ? undefined : `http://127.0.0.1:${port}/v1`,
    );
  } catch (error) {
    upstream.closeAllConnections();
    await new Promise<void>((done) => upstream.close(() => done()));
    throw error;
  }

  return {
    directory,
    dataRoot,
    accountHome,
    workspace,
    core,
    endpoint: `http://127.0.0.1:${port}/v1`,
    wrapper,
    key,
    requests,
    errors,
    state,
    close: async () => {
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}
