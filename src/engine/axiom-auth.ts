/** Host-only credentials. Never copied into model parameters or Core argv/env. */
export function bearerHeaders(
  endpoint: string,
  token?: string,
): Record<string, string> {
  if (token === undefined) return {};
  const u = new URL(endpoint);
  if (
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
    )
  )
    throw new Error(
      "Axiom Bearer authentication requires HTTPS; HTTP is allowed only on loopback",
    );
  return { Authorization: `Bearer ${validateBearer(token)}` };
}
export function validateBearer(value: string) {
  const token = value.trim();
  if (!token || token.length > 16384 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw new Error(
      "Enter the raw Bearer token, without the Bearer prefix, whitespace or control characters",
    );
  return token;
}
