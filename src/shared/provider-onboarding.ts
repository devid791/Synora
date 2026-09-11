import type { Integration } from "./contracts";
import { providerDefinitions, type ProviderType } from "./provider-registry";

/** A real mounted adapter preset, not a credential or an inference grant. */
export function providerPreset(
  type: ProviderType,
  existing: Integration[],
): Integration {
  const definition = providerDefinitions[type];
  const base = `synora-${type}`;
  let id = base,
    suffix = 2;
  while (existing.some((p) => p.id === id)) id = `${base}-${suffix++}`;
  return {
    id,
    name: definition.name,
    kind: "provider",
    providerType: type,
    endpoint: definition.endpoint,
    enabled: true,
    tools: [],
    auth: definition.credentials[0],
    ...(type === "compatible"
      ? { compatible: { protocol: "responses" as const } }
      : {}),
  };
}

/** Link an authenticated Core account without switching engines, overwriting a
 * user's disabled provider or copying any credential into configuration. */
export function accountProvider(
  account: { type: string } | null,
  existing: Integration[],
) {
  if (!account || !["apiKey", "chatgpt"].includes(account.type)) return null;
  if (
    existing.some((p) => p.kind === "provider" && p.providerType === "openai")
  )
    return null;
  return providerPreset("openai", existing);
}
