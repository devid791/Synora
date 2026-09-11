import { z } from "zod";
/** Own Google Desktop client only. Never import another application's tokens. */
export const googleClientSchema = z
  .object({
    clientId: z
      .string()
      .regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/)
      .max(512),
    clientSecret: z
      .string()
      .regex(/^[\x21-\x7e]{1,4096}$/)
      .optional(),
    quotaProject: z
      .string()
      .regex(/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,30})$/),
  })
  .strict();
export type GoogleClient = z.infer<typeof googleClientSchema>;
export interface GoogleAccountStatus {
  providerId: string;
  configured: boolean;
  authorized: boolean;
  storage: "os-encrypted" | "private-file";
  clientId?: string;
  quotaProject?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  needsLogin: boolean;
}
