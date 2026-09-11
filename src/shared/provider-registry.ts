/** One identity/label/auth registry. A listed requirement is NOT an executor. */
export const mountedProviderTypes = [
  "axiom",
  "openai",
  "xai",
  "anthropic",
  "gemini",
  "deepseek",
  "mistral",
  "openrouter",
  "compatible",
] as const;
export type MountedProviderType = (typeof mountedProviderTypes)[number];
export const providerDefinitions = {
  axiom: {
    name: "Axiom",
    endpoint: "",
    mounted: true,
    credentials: ["none", "api-key"],
    browser: "gateway-specific",
  },
  openai: {
    name: "OpenAI / ChatGPT",
    endpoint: "https://api.openai.com/v1",
    mounted: true,
    credentials: ["core-account"],
    browser: "core-account",
  },
  xai: {
    name: "xAI / Grok",
    endpoint: "https://api.x.ai/v1",
    mounted: true,
    credentials: ["api-key"],
    browser: "not-qualified",
  },
  anthropic: {
    name: "Anthropic / Claude",
    endpoint: "https://api.anthropic.com/v1",
    mounted: true,
    credentials: ["api-key"],
    browser: "not-qualified",
  },
  gemini: {
    name: "Google / Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    mounted: true,
    credentials: ["api-key", "oauth"],
    browser: "own-client-pkce",
  },
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    mounted: true,
    credentials: ["api-key"],
    browser: "not-qualified",
  },
  mistral: {
    name: "Mistral",
    endpoint: "https://api.mistral.ai/v1",
    mounted: true,
    credentials: ["api-key"],
    browser: "not-qualified",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    mounted: true,
    credentials: ["api-key"],
    browser: "pkce-key-exchange",
  },
  compatible: {
    name: "Custom compatible endpoint",
    endpoint: "",
    mounted: true,
    credentials: ["none", "api-key"],
    browser: "provider-specific",
  },
} as const;
export type ProviderType = keyof typeof providerDefinitions;

/** Shared routing semantics; model-owned context/effort is not an Axiom profile.
 * Unknown identities are never implicitly treated as available providers. */
export function providerUsesCoreModel(type: string | undefined): boolean {
  return (
    type !== undefined &&
    type !== "axiom" &&
    Object.hasOwn(providerDefinitions, type)
  );
}
export function providerRuntimeLabel(type: ProviderType | undefined): string {
  return {
    axiom: "Axiom",
    openai: "OpenAI",
    xai: "xAI",
    anthropic: "Anthropic",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    mistral: "Mistral",
    openrouter: "OpenRouter",
    compatible: "Compatible endpoint",
  }[type ?? "axiom"];
}

export function providerDefinition(type: string | undefined) {
  // Only historical records with an OMITTED type mean Axiom. Unknown explicit
  // identities must never inherit its protocol, telemetry or credentials.
  const id = type === undefined ? "axiom" : type;
  if (!Object.hasOwn(providerDefinitions, id))
    throw Error(`Unknown provider adapter: ${id}`);
  return providerDefinitions[id as ProviderType];
}
export function mountedProviderType(
  type: string | undefined,
): MountedProviderType {
  const definition = providerDefinition(type);
  if (!definition.mounted)
    throw Error(`${definition.name} inference adapter is not mounted`);
  return (type ?? "axiom") as MountedProviderType;
}
