import { createServer } from "node:http";
import { expect } from "@playwright/test";
import { controlledOpenAi } from "./openai-upstream";

/** Real pinned Core runs its own local tool. Only the model peer is controlled;
 * network must be loopback-only (enforced by the shared launcher fixture). */
export async function controlledMistral() {
  const base = await controlledOpenAi(),
    requests: {
      path: string;
      body: any;
      authorized: boolean;
      completed: boolean;
    }[] = [];
  const { state, errors, key, workspace } = base;
  let issued = false;
  const server = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe(`Bearer ${key}`);
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "mistral-small-latest",
                object: "model",
                created: 1,
                owned_by: "mistralai",
                aliases: [],
                max_context_length: 131072,
                capabilities: {
                  completion_chat: true,
                  function_calling: true,
                  vision: true,
                },
              },
              {
                id: "fixture-no-tools",
                object: "model",
                created: 1,
                owned_by: "fixture",
                aliases: [],
                max_context_length: 8192,
                capabilities: {
                  completion_chat: true,
                  function_calling: false,
                  vision: false,
                },
              },
            ],
          }),
        );
        return;
      }
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/chat/completions");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const record = {
        path: req.url!,
        body,
        authorized: true,
        completed: false,
      };
      requests.push(record);
      expect(body.model).toBe("mistral-small-latest");
      expect(body.stream).toBe(true);
      expect(body.reasoning_effort).toBe("high");
      expect(body).not.toHaveProperty("context_window");
      expect(body.tools.length).toBeGreaterThan(1);
      expect(body.tools.every((t: any) => t.type === "function")).toBe(true);
      const id = `mistral-core-fixture-${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = (
        value: any,
        finish_reason: string | null = null,
        usage?: any,
      ) =>
        res.write(
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: value, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`,
        );
      delta({ role: "assistant" });
      if (state.hold) {
        state.heldRequests++;
        res.once("close", () => state.cancelledStreams++);
        return;
      }
      delta({
        content: [
          {
            type: "thinking",
            thinking: [
              { type: "text", text: "Controlled Mistral fixture reasoning." },
            ],
            closed: true,
          },
        ],
      });
      if (!issued) {
        const mounted = body.tools.find((t: any) =>
          /Original Core tool: (functions\.)?exec\n/.test(
            t.function.description ?? "",
          ),
        );
        expect(mounted).toBeTruthy();
        expect(JSON.stringify(body.tools)).toContain("exec_command");
        const input = `text(await tools.exec_command(${JSON.stringify({ cmd: process.platform === "win32" ? "Get-Content -Raw -LiteralPath provider-check.txt" : "cat provider-check.txt", workdir: workspace, max_output_tokens: 200 })}));`;
        const args = JSON.stringify({ input });
        delta({
          tool_calls: [
            {
              index: 0,
              id: "MxCALL001",
              type: "function",
              function: { name: mounted.function.name, arguments: "" },
            },
          ],
        });
        for (let i = 0; i < args.length; i += 7)
          delta({
            tool_calls: [
              { index: 0, function: { arguments: args.slice(i, i + 7) } },
            ],
          });
        issued = true;
        delta({}, "tool_calls", {
          prompt_tokens: 20,
          completion_tokens: 10,
          total_tokens: 30,
        });
      } else {
        const result = body.messages.find(
          (m: any) => m.role === "tool" && m.tool_call_id === "MxCALL001",
        );
        expect(result).toBeTruthy();
        expect(JSON.stringify(result.content)).toContain(
          "SYNORA_PROVIDER_FILE_OK",
        );
        state.toolResult = result;
        const original = body.messages.find(
          (m: any) =>
            m.role === "assistant" &&
            m.tool_calls?.some((c: any) => c.id === "MxCALL001"),
        );
        expect(original).toBeTruthy();
        expect(JSON.stringify(original.content)).toContain(
          "Controlled Mistral fixture reasoning.",
        );
        delta({ content: "SYNORA_" });
        await new Promise((r) => setTimeout(r, 150));
        delta({ content: "PROVIDER_OK" });
        delta({}, "stop", {
          prompt_tokens: 30,
          completion_tokens: 10,
          total_tokens: 40,
        });
      }
      record.completed = true;
      res.end("data: [DONE]\n\n");
    } catch (e) {
      errors.push(String(e));
      if (!res.headersSent)
        res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(e) } }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Fixture listener failed");
  return {
    ...base,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
      await base.close();
    },
  };
}
