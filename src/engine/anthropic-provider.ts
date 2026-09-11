import { prepareResponsesProcess, responsesBridge } from "./responses-provider";
import type { prepareAxiomProcess } from "./axiom-process";
import type { ModelCapabilities } from "../shared/contracts";
import {
  anthropicEndpoint,
  anthropicModels,
  ANTHROPIC_VERSION,
  validateAnthropicSelection,
} from "./anthropic-models";
import { AnthropicHistory } from "./anthropic-history";
import { AnthropicEnvelope } from "./anthropic-envelope";
import { AnthropicStream } from "./anthropic-stream";
export { anthropicEndpoint, anthropicModels, validateAnthropicSelection };
export function anthropicBridge(options: {
  endpoint: string;
  token: string;
  model: ModelCapabilities;
  history: AnthropicHistory;
  deadlineMs?: number;
  onRequest?: Parameters<typeof responsesBridge>[0]["onRequest"];
}) {
  return responsesBridge({
    ...options,
    endpoint: anthropicEndpoint(options.endpoint),
    label: "Anthropic",
    errorPrefix: "ANTHROPIC",
    envelope: () => new AnthropicEnvelope(options.model, options.history),
    native: {
      path: "/messages",
      headers: { "anthropic-version": ANTHROPIC_VERSION },
      stream: (e) => new AnthropicStream(e as AnthropicEnvelope),
    },
  });
}
export const prepareAnthropicProcess: typeof prepareAxiomProcess = async (
  options,
) => {
  const endpoint = anthropicEndpoint(options.endpoint);
  const history = await AnthropicHistory.load(
    options.stateDirectory,
    endpoint,
    options.model,
  );
  return prepareResponsesProcess(options, {
    id: "synora_anthropic",
    name: "Anthropic",
    models: anthropicModels,
    validate: validateAnthropicSelection,
    bridge: (args) => anthropicBridge({ ...args, history }),
  });
};
