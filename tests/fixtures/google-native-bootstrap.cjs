// QA bootstrap only, not shipped. Loads the unchanged production main bundle;
// controls Google's token HTTP peer and external browser, not IPC/UI logic.
const path = require("node:path");
const { shell } = require("electron");
const endpoint = new URL(process.env.SYNORA_QA_GOOGLE_ENDPOINT);
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
  throw Error("Loopback QA peer required");
const transport = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const u = new URL(String(url));
  if (
    u.origin === "https://oauth2.googleapis.com" &&
    ["/token", "/revoke"].includes(u.pathname)
  )
    return transport(new URL(u.pathname, endpoint), options);
  return transport(url, options);
};
shell.openExternal = async (url) => {
  const u = new URL(url);
  if (
    u.origin !== "https://accounts.google.com" ||
    u.pathname !== "/o/oauth2/v2/auth"
  )
    throw Error("Unexpected external authorization URL");
  globalThis.synoraQaGoogleAuthorization = url;
};
require(path.resolve("dist/main.cjs"));
