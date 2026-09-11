import type { CompatibleSettings } from "../../src/shared/compatible-provider";
/** Capabilities belong to this controlled fixture, not any public model. */
export const compatibleFixtureSettings: CompatibleSettings = {
  protocol: "responses",
  modelOverrides: {
    "fixture/compatible-model": {
      contextWindow: 32768,
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "none",
      inputModalities: ["text"],
      outputModalities: ["text"],
      tools: true,
      supportedParameters: [
        "tools",
        "parallel_tool_calls",
        "prompt_cache_key",
        "reasoning.encrypted_content",
        "text.format",
      ],
    },
  },
};
