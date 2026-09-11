export const anthropicFixtureModel = {
  id: "claude-fixture-native",
  type: "model",
  display_name: "Controlled native Claude",
  created_at: "2026-01-01T00:00:00Z",
  max_input_tokens: 200000,
  max_tokens: 32768,
  capabilities: {
    image_input: { supported: true },
    structured_outputs: { supported: true },
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: false },
      max: { supported: true },
    },
    thinking: {
      supported: true,
      types: { adaptive: { supported: true }, enabled: { supported: false } },
    },
  },
};
export function nativeEvents(id: string, blocks: any[], reason = "end_turn") {
  const events: any[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: anthropicFixtureModel.id,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 20,
          output_tokens: 0,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    },
  ];
  blocks.forEach((b, index) => {
    const start =
      b.type === "tool_use"
        ? { ...b, input: {} }
        : b.type === "text"
          ? { ...b, text: "" }
          : b.type === "thinking"
            ? { ...b, thinking: "", signature: "" }
            : b;
    events.push({ type: "content_block_start", index, content_block: start });
    if (b.type !== "redacted_thinking") {
      const value =
        b.type === "tool_use"
          ? JSON.stringify(b.input)
          : b.type === "thinking"
            ? b.thinking
            : b.text;
      const type =
        b.type === "tool_use"
          ? "input_json_delta"
          : b.type === "thinking"
            ? "thinking_delta"
            : "text_delta";
      const field =
        b.type === "tool_use"
          ? "partial_json"
          : b.type === "thinking"
            ? "thinking"
            : "text";
      for (let i = 0; i < value.length; i += 7)
        events.push({
          type: "content_block_delta",
          index,
          delta: { type, [field]: value.slice(i, i + 7) },
        });
      if (b.type === "thinking")
        events.push({
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: b.signature },
        });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  );
  return events;
}
export const nativeSse = (events: any[]) =>
  Buffer.from(
    events
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join(""),
  );
