import { z } from "zod";
import type { GetAccountResponse } from "../protocol/codex-0.153.4/v2/GetAccountResponse";

// Original managed modes only. No renderer-supplied token exchange, RPC or issuer.
export const accountLoginSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("apiKey"), apiKey: z.string().min(1).max(16384) })
    .strict(),
  z.object({ type: z.literal("chatgpt") }).strict(),
  z.object({ type: z.literal("chatgptDeviceCode") }).strict(),
]);
export type AccountLogin = z.infer<typeof accountLoginSchema>;
export type CoreAccountAttempt = {
  id: string;
  loginId?: string | null;
  mode: AccountLogin["type"];
  status:
    | "starting"
    | "awaiting_browser"
    | "awaiting_device"
    | "verifying"
    | "authorized"
    | "failed"
    | "cancelled";
  expiresAt: number;
  authorizationUrl?: string;
  userCode?: string;
  code?: string;
  message?: string;
};
export type CoreAccountStatus = {
  busy: boolean;
  cleanupError?: string;
  account: GetAccountResponse | null;
  observedAt: number | null;
  attempt: CoreAccountAttempt | null;
  storage: "core-private-file";
};
export function openAiAuthorizationUrl(value: string) {
  const url = new URL(value);
  if (
    value.length > 16384 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["auth.openai.com", "auth.chatgpt.com", "chatgpt.com"].includes(
      url.hostname,
    )
  )
    throw new Error("Core returned an unexpected OpenAI authorization origin");
  return url.href;
}
