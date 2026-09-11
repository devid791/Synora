import { copyFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Test-only native launcher; never a production adapter or shell fallback. */
export async function controlledCoreLauncher(
  directory: string,
  core: string,
  endpoint?: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (endpoint && !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1$/.test(endpoint))
    throw Error("Controlled provider must be loopback-only");
  if (platform === "win32") {
    const prepared = process.env.SYNORA_QA_CORE_LAUNCHER;
    if (!prepared)
      throw Error("Build the QA-only native Windows Core launcher first");
    if (!(await stat(prepared)).isFile()) throw Error("Invalid QA launcher");
    if (/[\r\n\0]/.test(core)) throw Error("Invalid native executable path");
    const wrapper = join(directory, "controlled-core.exe");
    await copyFile(resolve(prepared), wrapper);
    // GetPrivateProfileStringW supports a BOM-prefixed UTF-16 INI, including
    // spaces/non-ASCII paths. The executable itself forwards exact argv.
    await writeFile(
      `${wrapper}.ini`,
      Buffer.from(
        `\ufeff[launcher]\r\nexecutable=${resolve(core)}\r\nendpoint=${endpoint ?? ""}\r\n`,
        "utf16le",
      ),
      { flag: "wx" },
    );
    return wrapper;
  }
  const wrapper = join(directory, "controlled-core.sh");
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  await writeFile(
    wrapper,
    endpoint
      ? `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${quote(core)} "$@"; fi\nexec ${quote(core)} "$@" -c ${quote(`openai_base_url="${endpoint}"`)}\n`
      : `#!/bin/sh\nexec ${quote(core)} "$@" 2>>${quote(join(directory, "xai-core-stderr.log"))}\n`,
    { mode: 0o700, flag: "wx" },
  );
  return wrapper;
}
