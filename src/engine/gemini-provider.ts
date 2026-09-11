import { responsesBridge, prepareResponsesProcess } from "./responses-provider";
import type { prepareAxiomProcess } from "./axiom-process";
import type { ModelCapabilities } from "../shared/contracts";
import { NativeHistory } from "./native-history";
import { GeminiEnvelope } from "./gemini-envelope";
import { GeminiStream } from "./gemini-stream";
import {
  geminiEndpoint,
  geminiModels,
  geminiKeyHeaders,
  geminiOAuthHeaders,
  type GeminiAuthorization,
  validateGeminiSelection,
} from "./gemini-models";
export { geminiEndpoint, geminiModels, validateGeminiSelection };
export function geminiBridge(options: {
  endpoint: string;
  token: string;
  oauth?: GeminiAuthorization;
  model: ModelCapabilities;
  history: NativeHistory;
  deadlineMs?: number;
  onRequest?: Parameters<typeof responsesBridge>[0]["onRequest"];
}) {
  const endpoint = geminiEndpoint(options.endpoint);
  if (!/^[A-Za-z0-9_.-]+$/.test(options.model.id))
    throw Error("Invalid native model path");
  return responsesBridge({
    ...options,
    endpoint,
    label: "Gemini",
    errorPrefix: "GEMINI",
    envelope: () => new GeminiEnvelope(options.model, options.history),
    native: {
      path: `/models/${options.model.id}:streamGenerateContent?alt=sse`,
      headers: options.oauth
        ? (signal) => geminiOAuthHeaders(endpoint, options.oauth!, signal)
        : geminiKeyHeaders(endpoint, options.token),
      authentication: "replace-bearer",
      stream: (e) => new GeminiStream(e as GeminiEnvelope),
    },
  });
}
export const prepareGeminiProcess: typeof prepareAxiomProcess = (options) =>
  prepareGemini(options);
export function prepareGeminiWithOAuth(
  oauth: GeminiAuthorization,
): typeof prepareAxiomProcess {
  return (options) => prepareGemini(options, oauth);
}
async function prepareGemini(
  options: Parameters<typeof prepareAxiomProcess>[0],
  oauth?: GeminiAuthorization,
) {
  const history = await NativeHistory.load(
    options.stateDirectory,
    geminiEndpoint(options.endpoint),
    options.model,
    "gemini",
  );
  return prepareResponsesProcess(options, {
    id: "synora_gemini",
    name: "Gemini",
    models: (endpoint, token) => geminiModels(endpoint, token, oauth),
    validate: validateGeminiSelection,
    bridge: (args) => geminiBridge({ ...args, history, oauth }),
  });
}
