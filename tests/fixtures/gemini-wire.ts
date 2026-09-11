import type { ModelCapabilities } from "../../src/shared/contracts";
export const geminiFixtureModel = {
  name: "models/gemini-fixture-native",
  displayName: "Controlled Gemini",
  inputTokenLimit: 100000,
  outputTokenLimit: 32768,
  supportedGenerationMethods: ["generateContent"],
  thinking: true,
  maxTemperature: 2,
};
export const geminiCapabilities: ModelCapabilities = {
  id: "gemini-fixture-native",
  context_window: 100000,
  context_window_options: [],
  reasoning_efforts: [],
  providerModel: {
    provider: "gemini",
    description: "Controlled catalog",
    inputModalities: ["text"],
    aliases: [],
    gemini: { maxOutput: 32768, thinking: true, maxTemperature: 2 },
  },
};
export const geminiSse = (frames: any[]) =>
  Buffer.from(frames.map((x) => `data: ${JSON.stringify(x)}\n\n`).join(""));
export function geminiFrames(id: string, parts: any[], reason = "STOP") {
  return [
    ...parts.map((p) => ({
      responseId: id,
      modelVersion: geminiCapabilities.id,
      candidates: [{ index: 0, content: { role: "model", parts: [p] } }],
    })),
    {
      responseId: id,
      candidates: [{ index: 0, finishReason: reason }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 10,
        totalTokenCount: 130,
        cachedContentTokenCount: 7,
      },
    },
  ];
}
