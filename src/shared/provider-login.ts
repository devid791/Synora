export interface ProviderLoginStatus {
  id: string;
  providerId: string;
  endpoint: string;
  method: "browser" | "paste-code";
  status:
    | "awaiting_authorization"
    | "exchanging"
    | "authorized"
    | "cancelled"
    | "expired"
    | "failed";
  expiresAt: number;
  authorizationUrl?: string;
  error?: string;
}
