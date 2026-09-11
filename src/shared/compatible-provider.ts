import { z } from "zod";

const names = z
  .array(z.string().min(1).max(128))
  .max(128)
  .refine(
    (values) => new Set(values).size === values.length,
    "Capability names must be unique",
  );
const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Operator assertions, not discovered or benchmarked capabilities. An omitted
 * field is unknown; [] explicitly declares no reasoning-effort selector. */
export const compatibleModelOverrideSchema = z
  .object({
    contextWindow: z.number().int().positive().safe().optional(),
    reasoningEfforts: z
      .array(effort)
      .max(7)
      .refine(
        (values) => new Set(values).size === values.length,
        "Reasoning efforts must be unique",
      )
      .optional(),
    defaultReasoningEffort: effort.nullable().optional(),
    inputModalities: names.optional(),
    outputModalities: names.optional(),
    tools: z.boolean().optional(),
    supportedParameters: names.optional(),
  })
  .strict();

export type CompatibleModelOverride = z.infer<
  typeof compatibleModelOverrideSchema
>;

/** Choosing Responses is explicit. No implicit Chat Completions detection or
 * fallback, credentials, arbitrary headers, or hosted-tool configuration. */
export const compatibleSettingsSchema = z
  .object({
    protocol: z.literal("responses"),
    modelOverrides: z
      .record(
        z
          .string()
          .min(1)
          .max(512)
          .refine(
            (id) => !["__proto__", "constructor", "prototype"].includes(id),
            "Reserved model override key",
          ),
        compatibleModelOverrideSchema,
      )
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    for (const [id, caps] of Object.entries(settings.modelOverrides ?? {})) {
      if (
        caps.defaultReasoningEffort != null &&
        caps.reasoningEfforts &&
        !caps.reasoningEfforts.includes(caps.defaultReasoningEffort)
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modelOverrides", id, "defaultReasoningEffort"],
          message: "Default effort must be in the declared reasoningEfforts",
        });
    }
  });
export type CompatibleSettings = z.infer<typeof compatibleSettingsSchema>;

function privateHost(host: string) {
  if (host === "localhost" || host === "[::1]") return true;
  // URL canonicalizes IPv4 shorthand/hex and IPv6 before this test. Unresolved
  // DNS names are not proof of a private address and cannot opt into HTTP.
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (/^\[(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/i.test(host)) return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16),
      low = parseInt(mapped[2], 16);
    return privateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return false;
}

/** API base URL: /models and /responses are appended, including custom prefixes.
 * HTTP exposes prompts/results in plaintext. Only loopback may also use a key;
 * private-network HTTP is anonymous-only (enforced by the engine's bearer check).
 * HTTPS may target any explicitly configured host. Redirects are never followed.
 */
export function compatibleEndpoint(value: string) {
  const message =
    "Compatible endpoint requires an HTTPS API base URL, or local/private HTTP (plaintext prompts/results; remote HTTP must be anonymous), without URL credentials, query or fragment";
  if (
    value !== value.trim() ||
    /[\\\s?#]/.test(value) ||
    !/^https?:\/\//i.test(value) ||
    /^https?:\/\/[^/]*@/i.test(value)
  )
    throw Error(message);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error(message);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && privateHost(url.hostname))
    )
  )
    throw Error(message);
  return url.href.replace(/\/+$/, "");
}
