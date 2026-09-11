/** Browser URL received from Core, never an arbitrary shell/IPC target. */
export function oauthBrowserUrl(value: string): string {
  const u = new URL(value);
  if (
    value.length > 16384 ||
    u.username ||
    u.password ||
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
    )
  )
    throw new Error(
      "OAuth requires HTTPS or an explicit loopback callback provider",
    );
  return u.href;
}
