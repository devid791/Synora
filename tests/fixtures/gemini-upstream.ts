import { expect } from "@playwright/test";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { controlledOpenAi } from "./openai-upstream";
import { geminiFixtureModel, geminiFrames, geminiSse } from "./gemini-wire";
export async function controlledGemini(auth?: {
  verify(headers: IncomingHttpHeaders): void;
  afterGeneration(): void;
}) {
  const base = await controlledOpenAi({ openrouter: true });
  await base.close();
  const requests: any[] = [],
    errors: string[] = [],
    signed: any[] = [];
  const state = {
    hold: false,
    heldRequests: 0,
    cancelledStreams: 0,
    toolResult: undefined as any,
  };
  let called = false;
  const server = createServer(async (req, res) => {
    try {
      if (auth) auth.verify(req.headers);
      else {
        expect(req.headers.authorization).toBeUndefined();
        expect(req.headers["x-goog-api-key"]).toBe(base.key);
      }
      if (req.method === "GET" && req.url === "/v1beta/models?pageSize=1000") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ models: [geminiFixtureModel] }));
        return;
      }
      expect(req.method).toBe("POST");
      expect(req.url).toBe(
        "/v1beta/models/gemini-fixture-native:streamGenerateContent?alt=sse",
      );
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const record = { body, completed: false };
      requests.push(record);
      expect(body.generationConfig).toEqual({
        candidateCount: 1,
        maxOutputTokens: 32768,
        thinkingConfig: { includeThoughts: true },
      });
      const exec = body.tools[0].functionDeclarations.find(
        (t: any) =>
          /^Original Core tool: (?:functions\.)?exec\n/.test(
            t.description ?? "",
          ) && t.parametersJsonSchema.properties?.input?.type === "string",
      );
      expect(exec).toBeTruthy();
      for (const content of signed)
        expect(body.contents).toContainEqual(content);
      const id = `gemini-original-${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (state.hold) {
        state.heldRequests++;
        res.write(geminiSse([{ responseId: id }]));
        res.once("close", () => state.cancelledStreams++);
        return;
      }
      let parts: any[];
      if (!called) {
        called = true;
        parts = [
          { text: "Controlled summary €", thought: true },
          {
            functionCall: {
              id: "gemini_original_read",
              name: exec.name,
              args: {
                input: `text(await tools.exec_command(${JSON.stringify({ cmd: process.platform === "win32" ? "Get-Content -Raw -LiteralPath provider-check.txt" : "cat provider-check.txt", workdir: base.workspace, max_output_tokens: 200 })}));`,
              },
            },
            thoughtSignature: "signature-first-call",
          },
        ];
      } else {
        const result = body.contents
          .flatMap((x: any) => x.parts)
          .find((x: any) => x.functionResponse?.id === "gemini_original_read");
        expect(result).toBeTruthy();
        expect(JSON.stringify(result.functionResponse.response)).toContain(
          "SYNORA_PROVIDER_FILE_OK",
        );
        state.toolResult = result;
        parts = [
          { text: "SYNORA_" },
          { text: "GEMINI_OK" },
          {
            text: "",
            thoughtSignature: `empty-part-signature-${requests.length}`,
          },
        ];
      }
      const frames = geminiFrames(id, parts);
      res.write(geminiSse(frames.slice(0, -1)));
      await new Promise((r) => setTimeout(r, 120));
      signed.push({ role: "model", parts });
      record.completed = true;
      auth?.afterGeneration();
      res.end(geminiSse(frames.slice(-1)));
    } catch (e) {
      errors.push(String(e));
      res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    ...base,
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1beta`,
    requests,
    errors,
    signed,
    state,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
