import { z } from "zod";

// An upload bound, not a model context/vision limit. Keep original bytes.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_UPLOAD_JSON_BYTES =
  Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4096;
export const imageMimes = ["image/png", "image/jpeg", "image/webp"] as const;
export const imageAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    mime: z.enum(imageMimes),
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>;
export const imageUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    dataUrl: z.string().max(IMAGE_UPLOAD_JSON_BYTES),
  })
  .strict();
export type ImageUpload = z.infer<typeof imageUploadSchema>;
