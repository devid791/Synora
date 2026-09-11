import { z } from "zod";

// This module deliberately has no dependency on contracts, Store or Node APIs.
export const AGENCY_MAX_BODY_BYTES = 64 * 1024;
export const AGENCY_MAX_INSTRUCTIONS = 16_000;
export const AGENCY_MAX_ENTRIES = 10_000;
export const AGENCY_CATEGORIES = [
  "academic",
  "design",
  "engineering",
  "finance",
  "game-development",
  "gis",
  "healthcare",
  "marketing",
  "paid-media",
  "product",
  "project-management",
  "research",
  "sales",
  "security",
  "spatial-computing",
  "specialized",
  "strategy",
  "support",
  "testing",
] as const;

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const forbidden =
  /(?:translat|localiz|localis|i18n|l10n|multilingual|non-english)/i;
const languages =
  /(?:^|[._-])(?:ar|bg|bn|cs|da|de|el|en|es|fa|fi|fr|he|hi|hr|hu|id|it|ja|ko|lt|nl|no|pl|pt|ro|ru|sk|sr|sv|th|tr|uk|ur|vi|zh|chinese|japanese|korean|spanish|french|german|portuguese|russian|italian|arabic|hindi|turkish)(?:$|[._-])/i;
const excludedSegment =
  /^(?:scripts?|integrations?|\.github|examples?|docs?|readme|license|licence|contributing|changelog|code-of-conduct)(?:$|[._-])/i;

export function isAgencyRolePath(path: string): boolean {
  if (path.length > 512 || !path.endsWith(".md")) return false;
  const parts = path.split("/");
  return (
    parts.length >= 2 &&
    parts.length <= 12 &&
    (AGENCY_CATEGORIES as readonly string[]).includes(parts[0]) &&
    parts.every(
      (part) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) &&
        !forbidden.test(part) &&
        !languages.test(part) &&
        !excludedSegment.test(part),
    )
  );
}

export const agencyCatalogEntrySchema = z
  .object({
    id: z.string().min(1).max(512),
    path: z
      .string()
      .refine(isAgencyRolePath, "Not an allowed English role path"),
    name: z.string().min(1).max(512),
    category: z.enum(AGENCY_CATEGORIES),
    blobSha: sha,
    bytes: z.number().int().positive().max(AGENCY_MAX_BODY_BYTES),
  })
  .strict()
  .refine(
    (e) => e.id === e.path && e.category === e.path.split("/")[0],
    "Entry identity/category must match its path",
  );

export const agencyCatalogSnapshotSchema = z
  .object({
    source: z.literal("agency-agents"),
    revision: sha,
    fetchedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entries: z.array(agencyCatalogEntrySchema).max(AGENCY_MAX_ENTRIES),
    license: z.literal("MIT"),
    // Eligible regular Markdown files excluded because they are empty or >64 KiB.
    // Unsupported directories, translations and executables are not catalog roles.
    excludedCount: z.number().int().nonnegative().max(30_000).optional(),
  })
  .strict()
  .refine(
    (s) => new Set(s.entries.map((e) => e.id)).size === s.entries.length,
    "Duplicate catalog entries",
  );

export const agencySourceProvenanceSchema = z
  .object({
    source: z.literal("agency-agents"),
    revision: sha,
    path: z.string().refine(isAgencyRolePath),
    blobSha: sha,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceUrl: z.string().max(1024),
    license: z.literal("MIT"),
    licenseText: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict()
  .refine(
    (p) => p.sourceUrl === agencySourceUrl(p.revision, p.path),
    "Source URL must be pinned to the fixed repository",
  );

export const agencyPreviewSchema = z
  .object({
    id: z.string().uuid(),
    entry: agencyCatalogEntrySchema,
    revision: sha,
    instructions: z.string().min(1).max(AGENCY_MAX_INSTRUCTIONS),
    original: z.string().min(1).max(AGENCY_MAX_BODY_BYTES),
    sourceUrl: z.string().max(1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    licenseText: z
      .string()
      .min(1)
      .max(16 * 1024),
    warnings: z.array(z.string().max(1024)).max(8),
  })
  .strict()
  .refine(
    (p) => p.sourceUrl === agencySourceUrl(p.revision, p.entry.path),
    "Preview URL must be pinned to the selected revision",
  );

export type AgencyCatalogEntry = z.infer<typeof agencyCatalogEntrySchema>;
export type AgencyCatalogSnapshot = z.infer<typeof agencyCatalogSnapshotSchema>;
export type AgencySourceProvenance = z.infer<
  typeof agencySourceProvenanceSchema
>;
export type AgencyPreview = z.infer<typeof agencyPreviewSchema>;

export function agencySourceUrl(revision: string, path: string): string {
  return `https://github.com/msitarzewski/agency-agents/blob/${revision}/${path}`;
}
