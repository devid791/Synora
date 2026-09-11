import { expect } from "@playwright/test";
import { createServer } from "node:http";
import { controlledOpenAi } from "./openai-upstream";
import {
  anthropicFixtureModel,
  nativeEvents,
  nativeSse,
} from "./anthropic-wire";

/** Reuse the existing isolated original-Core/workspace setup, then replace only
 * the controlled remote protocol. No public Anthropic or OpenAI request. */
export async function controlledAnthropic() {
  const base = await controlledOpenAi({ openrouter: true });
  await base.close(); // Setup's Responses listener is unused; never two engines.
  const requests: any[] = [],
    errors: string[] = [];
  const state = {
    hold: false,
    heldRequests: 0,
    cancelledStreams: 0,
    toolResult: undefined as any,
  };
  const signed: any[] = [];
  let called = false;
  const upstream = createServer(async (req, res) => {
    try {
      expect(req.headers.authorization).toBe(`Bearer ${base.key}`);
      expect(req.headers["anthropic-version"]).toBe("2023-06-01");
      if (req.method === "GET" && req.url === "/v1/models?limit=1000") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [anthropicFixtureModel],
            has_more: false,
            last_id: anthropicFixtureModel.id,
          }),
        );
        return;
      }
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/v1/messages");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const record = { body, completed: false };
      requests.push(record);
      expect(body.model).toBe(anthropicFixtureModel.id);
      expect(body.stream).toBe(true);
      expect(body.max_tokens).toBe(32768);
      expect(body.output_config).toEqual({ effort: "high" });
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.input).toBeUndefined();
      // Use the identity in this original Core catalog, never assume the
      // namespace of a different model/provider fixture.
      const executor = body.tools.find(
        (t: any) =>
          /^Original Core tool: (?:functions\.)?exec\n/.test(
            t.description ?? "",
          ) &&
          t.input_schema.properties?.input?.type === "string" &&
          t.input_schema.required?.length === 1 &&
          t.input_schema.required[0] === "input",
      );
      expect(executor).toBeTruthy();
      const exec = executor.name;
      const history = body.messages.flatMap((m: any) => m.content);
      for (const block of signed) expect(history).toContainEqual(block);
      const id = `msg_fixture_${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (state.hold) {
        state.heldRequests++;
        res.write(nativeSse(nativeEvents(id, []).slice(0, 1)));
        res.once("close", () => state.cancelledStreams++);
        return;
      }
      const thinking = {
        type: "thinking",
        thinking: `Controlled reasoning ${requests.length} €`,
        signature: `original-signature-${requests.length}`,
      };
      let blocks: any[],
        reason = "end_turn";
      if (!called) {
        called = true;
        reason = "tool_use";
        blocks = [
          thinking,
          {
            type: "tool_use",
            id: "toolu_original_read",
            name: exec,
            input: {
              input: `text(await tools.exec_command(${JSON.stringify({ cmd: process.platform === "win32" ? "Get-Content -Raw -LiteralPath provider-check.txt" : "cat provider-check.txt", workdir: base.workspace, max_output_tokens: 200 })}));`,
            },
          },
        ];
      } else {
        const result = history.find(
          (x: any) =>
            x.type === "tool_result" && x.tool_use_id === "toolu_original_read",
        );
        expect(result).toBeTruthy();
        expect(JSON.stringify(result.content)).toContain(
          "SYNORA_PROVIDER_FILE_OK",
        );
        state.toolResult = result;
        blocks = [thinking, { type: "text", text: "SYNORA_ANTHROPIC_OK" }];
      }
      const events = nativeEvents(id, blocks, reason);
      for (const event of events.slice(0, -2)) res.write(nativeSse([event]));
      await new Promise((r) => setTimeout(r, 120));
      signed.push(thinking);
      res.end(nativeSse(events.slice(-2)));
      record.completed = true;
    } catch (e) {
      errors.push(String(e));
      res.destroy();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  return {
    ...base,
    endpoint: `http://127.0.0.1:${(upstream.address() as any).port}/v1`,
    requests,
    errors,
    state,
    signed,
    close: async () => {
      upstream.closeAllConnections();
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}
