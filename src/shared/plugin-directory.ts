import { z } from "zod";

// Data only. No provider, workspace, Core, preferences or installation state.
export const PLUGIN_DIRECTORY_SOURCE_URL = "https://github.com/openai/plugins";
export const PLUGIN_DIRECTORY_MARKETPLACE_PATH =
  ".agents/plugins/marketplace.json";
export const PLUGIN_DIRECTORY_SEED_REVISION =
  "d416fd5a43426019986b1e489506db3db66dee3d";
export const PLUGIN_DIRECTORY_MAX_ENTRIES = 256;
export const PLUGIN_DIRECTORY_MAX_ICON_BYTES = 512 * 1024;
export const PLUGIN_DIRECTORY_MAX_CACHE_BYTES = 32 * 1024 * 1024;

const plain = (max: number) =>
  z
    .string()
    .max(max)
    .refine(
      (s) => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s),
      "Expected bounded plain text",
    );
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const pluginDirectoryRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);

export function isPluginDirectoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value
      .split("/")
      .every(
        (part) =>
          part !== "." && part !== ".." && /^[A-Za-z0-9._-]{1,128}$/.test(part),
      )
  );
}
const path = z.string().refine(isPluginDirectoryPath, "Invalid source path");
const https = plain(2048).refine((value) => {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.port &&
      !/[\s\\]/.test(value)
    );
  } catch {
    return false;
  }
}, "Expected credential-free HTTPS metadata");

export function pluginDirectorySourceUrl(
  revision: string,
  path: string,
): string {
  return `${PLUGIN_DIRECTORY_SOURCE_URL}/blob/${revision}/${path}`;
}

export const pluginDirectoryLicenseSchema = z
  .object({
    path,
    sourceUrl: https,
    text: plain(64 * 1024).refine((s) => s.length > 0),
    sha256,
  })
  .strict();

export const pluginDirectoryEntrySchema = z
  .object({
    id: plain(160),
    name,
    displayName: plain(256).refine((s) => s.length > 0),
    description: plain(16 * 1024),
    version: plain(128).nullable(),
    category: plain(128),
    sourceUrl: https,
    icon: z
      .object({
        dataUrl: z
          .string()
          .max(Math.ceil(PLUGIN_DIRECTORY_MAX_ICON_BYTES / 3) * 4 + 64)
          .regex(
            /^data:image\/(?:png|jpeg|gif|webp|x-icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/,
          ),
        sha256,
      })
      .strict()
      .nullable(),
    // Presence of a source .app.json, NOT an account grant or usability claim.
    requiresAccount: z.boolean(),
    iconError: plain(512).optional(),
    metadataOrigin: z.enum(["manifest", "marketplace"]).optional(),
    manifestPath: path.nullable().optional(),
    manifestSha256: sha256.nullable().optional(),
    declaredSourceKind: z.enum(["local", "url", "git-subdir"]).optional(),
    declaredSourceUrl: https.nullable().optional(),
    declaredSourcePath: path.nullable().optional(),
    accountRequirementKnown: z.boolean().optional(),
    developerName: plain(256).nullable().optional(),
    homepage: https.nullable().optional(),
    license: plain(512).nullable().optional(),
    licenseFiles: z.array(pluginDirectoryLicenseSchema).max(8).optional(),
    iconPath: path.nullable().optional(),
    iconSourceField: z
      .enum(["logo", "composerIcon", "logoDark"])
      .nullable()
      .optional(),
    keywords: z.array(plain(128)).max(64).optional(),
  })
  .strict()
  .refine(
    (e) => e.id === `${e.name}@openai-curated`,
    "Invalid stable identity",
  );

export const pluginDirectorySnapshotSchema = z
  .object({
    sourceUrl: z.literal(PLUGIN_DIRECTORY_SOURCE_URL),
    revision: pluginDirectoryRevisionSchema,
    // Epoch milliseconds. Seed uses the recorded generation time, never a network read.
    fetchedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entries: z
      .array(pluginDirectoryEntrySchema)
      .min(1)
      .max(PLUGIN_DIRECTORY_MAX_ENTRIES),
    checking: z.boolean(),
    error: plain(1024).nullable(),
    marketplaceSha256: sha256.optional(),
    repositoryLicenseFiles: z
      .array(pluginDirectoryLicenseSchema)
      .max(8)
      .optional(),
    repositoryLicenseNote: plain(512).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const issue = () =>
      ctx.addIssue({
        code: "custom",
        message: "Invalid directory provenance or duplicate identity",
      });
    if (new Set(s.entries.map((e) => e.id)).size !== s.entries.length) issue();
    for (const e of s.entries) {
      const manifest = e.manifestPath ?? PLUGIN_DIRECTORY_MARKETPLACE_PATH;
      if (e.sourceUrl !== pluginDirectorySourceUrl(s.revision, manifest))
        issue();
      if (
        e.manifestPath &&
        e.manifestPath !== `plugins/${e.name}/.codex-plugin/plugin.json`
      )
        issue();
      if (e.iconPath && !e.iconPath.startsWith(`plugins/${e.name}/`)) issue();
      for (const l of e.licenseFiles ?? []) {
        if (
          !l.path.startsWith(`plugins/${e.name}/`) ||
          l.sourceUrl !== pluginDirectorySourceUrl(s.revision, l.path)
        )
          issue();
      }
    }
    for (const l of s.repositoryLicenseFiles ?? []) {
      if (
        l.path.includes("/") ||
        l.sourceUrl !== pluginDirectorySourceUrl(s.revision, l.path)
      )
        issue();
    }
  });

export type PluginDirectoryEntry = z.infer<typeof pluginDirectoryEntrySchema>;
export type PluginDirectorySnapshot = z.infer<
  typeof pluginDirectorySnapshotSchema
>;
export type PluginDirectoryLicense = z.infer<
  typeof pluginDirectoryLicenseSchema
>;
