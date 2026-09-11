import { prepareResponsesProcess, responsesBridge } from "./responses-provider";
import type { prepareAxiomProcess } from "./axiom-process";
import type { ModelCapabilities } from "../shared/contracts";
import { NativeHistory } from "./native-history";
import { MistralEnvelope } from "./mistral-envelope";
import { MistralStream } from "./mistral-stream";
import {
  mistralEndpoint,
  mistralModels,
  validateMistralSelection,
} from "./mistral-models";
export { mistralEndpoint, mistralModels, validateMistralSelection };

export function mistralBridge(options: {
  endpoint: string;
  token: string;
  model: ModelCapabilities;
  history: NativeHistory;
  deadlineMs?: number;
  onRequest?: Parameters<typeof responsesBridge>[0]["onRequest"];
}) {
  return responsesBridge({
    ...options,
    endpoint: mistralEndpoint(options.endpoint),
    label: "Mistral",
    errorPrefix: "MISTRAL",
    envelope: () => new MistralEnvelope(options.model, options.history),
    native: {
      path: "/chat/completions",
      headers: {},
      stream: (e) => new MistralStream(e as MistralEnvelope),
    },
  });
}
export const prepareMistralProcess: typeof prepareAxiomProcess = async (
  options,
) => {
  const history = await NativeHistory.load(
    options.stateDirectory,
    mistralEndpoint(options.endpoint),
    options.model,
    "mistral",
  );
  return prepareResponsesProcess(options, {
    id: "synora_mistral",
    name: "Mistral",
    models: mistralModels,
    validate: validateMistralSelection,
    bridge: (args) => mistralBridge({ ...args, history }),
  });
};
