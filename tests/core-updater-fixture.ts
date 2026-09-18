import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "tar";
import {
  corePackage,
  installCore,
  sha256File,
} from "../src/engine/core-runtime";
import type { QualifiedCore } from "../src/engine/qualified-core";
import { REQUIRED_CORE_GATES } from "../src/engine/qualified-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppServerTransport } from "../src/engine/app-server-transport";
import { appServerEnvironment } from "../src/engine/axiom-process";
import { parseResponse } from "../src/engine/protocol-validation";
export async function updaterFixture(root: string, broken = false) {
  const releases = new Map<
    string,
    { release: QualifiedCore; archive: string }
  >();
  for (const version of ["0.153.4", "0.153.5"]) {
    const entrypoint =
      process.platform === "win32" ? "bin/codex.exe" : "bin/codex";
    const directory = join(root, version);
    await mkdir(join(directory, "bin"), { recursive: true });
    const files: Record<string, [number, string]> = {};
    const values = {
      "codex-package.json": JSON.stringify({
        layoutVersion: 1,
        version,
        target: corePackage().target,
        variant: "codex",
        entrypoint,
        pathDir: "codex-path",
        resourcesDir: "codex-resources",
      }),
      [entrypoint]: `#!/usr/bin/env node\nif(process.argv.includes('--version')){console.log('codex-cli ${version}');process.exit(0);}require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const q=JSON.parse(l);if(q.method==='initialize')console.log(JSON.stringify({id:q.id,result:${broken && version === "0.153.5" ? "{}" : "{userAgent:'fixture',platformFamily:'unix',platformOs:'linux',codexHome:process.env.CODEX_HOME}"}}));if(q.method==='config/read')console.log(JSON.stringify({id:q.id,result:{config:{},origins:{},layers:null}}));if(q.method==='thread/list')console.log(JSON.stringify({id:q.id,result:{data:[],nextCursor:null,backwardsCursor:null}}));});\n`,
    };
    for (const [name, data] of Object.entries(values)) {
      await writeFile(join(directory, name), data, { mode: 0o700 });
      files[name] = [
        Buffer.byteLength(data),
        createHash("sha256").update(data).digest("hex"),
      ];
    }
    const archive = join(root, `${version}.tar.gz`);
    await create(
      { file: archive, cwd: directory, gzip: true, portable: true },
      Object.keys(values),
    );
    releases.set(version, {
      archive,
      release: {
        package: {
          ...corePackage(),
          version,
          files,
          file: `codex-package-${corePackage().target}.tar.gz`,
          size: (await readFile(archive)).length,
          sha256: await sha256File(archive),
        },
        protocol: "0.153.4",
        qualification: {
          sourceCommit: "a".repeat(40),
          evidenceSha256: "b".repeat(64),
          checks: [...REQUIRED_CORE_GATES],
        },
      },
    });
  }
  const lookup = (version: string) => {
    const found = releases.get(version);
    if (!found) throw Error("Not qualified");
    return found.release;
  };
  return {
    releases,
    options: {
      bundledVersion: "0.153.4",
      // Windows does not execute shebang scripts. This is a controlled protocol
      // fixture launched by Node, never represented as a genuine Core binary.
      ...(process.platform === "win32"
        ? {
            probe: async (
              executable: string,
              version: string,
              home: string,
            ) => {
              const env = appServerEnvironment(home);
              if (
                (
                  await promisify(execFile)(
                    process.execPath,
                    [executable, "--version"],
                    { cwd: home, env, timeout: 5000 },
                  )
                ).stdout.trim() !== `codex-cli ${version}`
              )
                throw Error("Fixture version mismatch");
              const transport = new AppServerTransport({
                executable: process.execPath,
                args: [executable, "app-server"],
                cwd: home,
                env,
                requestTimeoutMs: 5000,
                onNotification: () => {},
                onRequest: () => {},
                onClose: () => {},
              });
              try {
                parseResponse(
                  "initialize",
                  await transport.request("initialize", {
                    clientInfo: { name: "fixture", version: "1" },
                  }),
                );
                transport.notify("initialized");
              } finally {
                await transport.close();
              }
            },
          }
        : {}),
      lookup,
      available: ["0.153.5"],
      initialDelayMs: 20,
      archive: async (r: QualifiedCore) =>
        releases.get(r.package.version)!.archive,
      bundled: () =>
        installCore(
          releases.get("0.153.4")!.archive,
          join(root, "baseline"),
          lookup("0.153.4").package,
        ),
      fetch: (async () =>
        Response.json({
          tag_name: "rust-v0.153.6",
          draft: false,
          prerelease: false,
        })) as typeof fetch,
    },
  };
}
