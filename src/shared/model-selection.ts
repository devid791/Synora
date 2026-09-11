import { z } from "zod";
import type { ModelCapabilities } from "./contracts";
import { mountedProviderType } from "./provider-registry";

const contextSchema = z.number().int().positive().safe();

/** Exact configured-provider/model identities; no aliases or normalization. */
export const selectionSchema = z
  .object({
    providerId: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().min(1).optional(),
    context: contextSchema.optional(),
  })
  .strict();
export type ModelSelection = z.infer<typeof selectionSchema>;

/** Shared supervisor/worker selection, without fetching or caching inventories.
 * The caller must resolve an enabled providerId and supply its current,
 * authorized inventory: ModelCapabilities has no configuration ID or timestamp.
 * Adapter preparation still revalidates before execution. Keep the original
 * selection separate from defaults; an empty resolved profile means no override.
 */
export function resolveModelSelection(
  selection: ModelSelection,
  providerType: string | undefined,
  models: ModelCapabilities[],
): {
  selection: ModelSelection;
  profile: string;
  context: number | null;
  model: ModelCapabilities;
} {
  const parsed = selectionSchema.parse(selection),
    type = mountedProviderType(providerType),
    matches = models.filter((model) => model.id === parsed.model);
  if (!matches.length)
    throw Error(
      "Selected model is not advertised by the current provider catalog",
    );
  if (matches.length !== 1)
    throw Error(
      "Selected model identity is ambiguous in the current provider catalog",
    );
  const model = matches[0];
  if (model.unavailableReason !== undefined)
    throw Error(
      `Selected model is unavailable: ${model.unavailableReason || "catalog marks it unavailable"}`,
    );
  // Reject contradictory provenance when the inventory includes it. A catalog
  // ID is the inference ID, not Core's picker ID or a provider's alias list.
  if (
    (model.providerModel && model.providerModel.provider !== type) ||
    (model.coreModel &&
      (type !== "openai" ||
        model.coreModel.model !== model.id ||
        model.coreModel.hidden))
  )
    throw Error(
      "Selected model metadata differs from this provider catalog; reload the catalog",
    );

  const defaultEffort = model.default_reasoning_effort;
  if (
    defaultEffort !== undefined &&
    (!defaultEffort || !model.reasoning_efforts.includes(defaultEffort))
  )
    throw Error(
      "Model default reasoning effort is not advertised by this model",
    );
  if (
    parsed.effort !== undefined &&
    !model.reasoning_efforts.includes(parsed.effort)
  )
    throw Error("Selected reasoning effort is not advertised by this model");
  const profile = parsed.effort ?? defaultEffort ?? "";

  let context: number | null = null;
  if (type === "axiom") {
    const options = model.context_window_options;
    if (options.some((option) => !contextSchema.safeParse(option).success))
      throw Error("Axiom catalog advertises an invalid context option");
    if (parsed.context !== undefined) {
      if (!options.includes(parsed.context))
        throw Error("Selected context is not advertised by this Axiom model");
      context = parsed.context;
    } else if (options.length === 1) context = options[0];
    else
      throw Error(
        "Axiom requires an explicit advertised context unless there is a sole option",
      );
  } else if (parsed.context !== undefined) {
    // Both prepareOpenAiProcess and prepareResponsesProcess require null.
    // Catalog options alone cannot grant an adapter context-override support.
    throw Error(
      "Provider adapter does not support context overrides; use Core-managed context",
    );
  }

  return { selection: parsed, profile, context, model };
}
