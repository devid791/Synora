import { createRoot } from "react-dom/client";
import { AxiomTelemetry } from "../../src/renderer/AxiomTelemetry";
import type { AxiomRequestMetrics } from "../../src/shared/contracts";
const metrics: AxiomRequestMetrics = {
  source: "axiom-response",
  responseId: "response-fixture-1",
  sessionId: "session-fixture",
  threadId: "thread-fixture-with-a-long-but-valid-identity",
  turnId: "turn-fixture-with-a-long-but-valid-identity",
  model: "fixture-model",
  profile: "medium",
  observedAt: 1788919000000,
  thinkingTokens: 24,
  visibleTokens: 6,
  thinkingBudget: 4096,
  inputTokens: 100,
  outputTokens: 30,
  totalTokens: 130,
  prefillSeconds: 1,
  decodeSeconds: 0.5,
  ttftSeconds: 1.01,
  decodeTokensPerSecond: 60,
  visibleTokensPerSecond: 12,
  decodePath: "scalar_sampling",
  speculativeMode: "target",
  prefixHitTokens: 80,
  suffixPrefillTokens: 20,
};
createRoot(document.getElementById("root")!).render(
  <>
    <AxiomTelemetry />
    <AxiomTelemetry
      requests={[metrics, { ...metrics, responseId: "response-fixture-2" }]}
    />
  </>,
);
