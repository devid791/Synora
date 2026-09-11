import { z } from "zod";

// Only an identity from the current original Core catalog, never a URL/path.
export const catalogIconRequestSchema = z
  .object({
    catalogId: z.string().min(1).max(160),
    kind: z.enum(["plugin", "app"]),
    id: z.string().min(1).max(512),
    marketplace: z.string().min(1).max(512).optional(),
    theme: z.enum(["light", "dark"]),
    refresh: z.boolean().optional(),
  })
  .strict();
export type CatalogIconRequest = z.infer<typeof catalogIconRequestSchema>;
export type CatalogIcon =
  | {
      status: "ready";
      dataUrl: string;
      sha256: string;
      source: "local" | "https";
      field: string;
    }
  | { status: "missing"; message: string }
  | { status: "unavailable"; code: string; message: string };
