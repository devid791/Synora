import { readFile, writeFile, realpath, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, isAbsolute } from "node:path";

// Audited lifecycle patch for the pinned MIT-licensed node-pty 1.1.0.
// Keep upstream notices. Reject a different dependency rather than guessing.
const originalHash =
  "8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a";
const marker = "// Synora node-pty 1.1.0 Windows lifecycle patch v1\n";
const killBefore = `                });
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._conoutSocketWorker.dispose();`;
const killAfter = `                    _this._ptyNative.kill(_this._pty, _this._useConptyDll);
                    _this._conoutSocketWorker.dispose();
                });`;
const cleanupBefore = `        this._outSocket.destroy();
    };
    return WindowsPtyAgent;`;
const cleanupAfter = `        this._outSocket.destroy();
        this._inSocket.destroy();
        this._conoutSocketWorker.dispose();
    };
    return WindowsPtyAgent;`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw new Error("Unexpected node-pty patch context");
  return source.replace(before, after);
}
export async function patchWindowsPty(projectRoot) {
  const root = await realpath(projectRoot),
    dependency = join(root, "node_modules/node-pty"),
    target = join(dependency, "lib/windowsPtyAgent.js");
  const stat = await lstat(target),
    actual = await realpath(target),
    inside = relative(root, actual);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    inside.startsWith("..") ||
    isAbsolute(inside)
  )
    throw new Error(
      "node-pty patch target is not an application-owned regular file",
    );
  if (
    JSON.parse(await readFile(join(dependency, "package.json"), "utf8"))
      .version !== "1.1.0"
  )
    throw new Error("Windows lifecycle patch requires node-pty 1.1.0");
  const source = await readFile(target, "utf8");
  if (source.startsWith(marker)) {
    const original = replaceOnce(
      replaceOnce(source.slice(marker.length), cleanupAfter, cleanupBefore),
      killAfter,
      killBefore,
    );
    if (hash(original) !== originalHash)
      throw new Error("Previously patched node-pty has unexpected changes");
    return;
  }
  if (hash(source) !== originalHash)
    throw new Error("Pinned node-pty source SHA256 mismatch");
  const patched =
    marker +
    replaceOnce(
      replaceOnce(source, killBefore, killAfter),
      cleanupBefore,
      cleanupAfter,
    );
  await writeFile(actual, patched);
}
