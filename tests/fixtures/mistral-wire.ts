import type { ModelCapabilities } from "../../src/shared/contracts";
/** Offline native wire examples. These are controlled peers, not public inference. */
export const mistralFixtureModel = {
  id: "mistral-small-latest",
  name: "Controlled Mistral Small",
  max_context_length: 262144,
  aliases: ["mistral-small-2603"],
  capabilities: {
    completion_chat: true,
    completion_fim: false,
    function_calling: true,
    vision: true,
  },
};
export const mistralCapabilities: ModelCapabilities = {
  id: mistralFixtureModel.id,
  context_window: 262144,
  context_window_options: [],
  reasoning_efforts: ["none", "high"],
  default_reasoning_effort: "none",
  providerModel: {
    provider: "mistral",
    aliases: ["mistral-small-2603"],
    inputModalities: ["text", "image"],
    description: "Controlled catalog",
    mistral: { functionCalling: true },
  },
};
export const mistralSse = (frames: any[], done = true) =>
  Buffer.from(
    frames.map((x) => `data: ${JSON.stringify(x)}\r\n\r\n`).join("") +
      (done ? "data: [DONE]\r\n\r\n" : ""),
  );
export function mistralFrames(
  id: string,
  deltas: any[],
  reason = "stop",
  usage: any = { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
) {
  const frame = (delta: any, finish_reason: string | null) => ({
    id,
    model: mistralCapabilities.id,
    created: 1788900000,
    object: "chat.completion.chunk",
    p: "wire-padding",
    choices: [{ index: 0, delta, finish_reason }],
  });
  return [
    ...deltas.map((d) => frame(d, null)),
    { ...frame({}, reason), ...(usage === undefined ? {} : { usage }) },
  ];
}
export function mistralToolDeltas(
  name: string,
  id = "aB1234567",
  input = "text(42)",
) {
  const args = JSON.stringify({ input });
  return [
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: [{ type: "text", text: "Reason €" }],
          closed: false,
        },
      ],
    },
    {
      content: [
        {
          type: "thinking",
          thinking: [{ type: "text", text: " first" }],
          signature: "controlled-original-signature",
          closed: true,
        },
        { type: "text", text: "Checking." },
      ],
    },
    {
      tool_calls: [
        {
          index: 0,
          id,
          type: "function",
          function: { name, arguments: args.slice(0, 8) },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] },
  ];
}
