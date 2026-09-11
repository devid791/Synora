import {
  mkdtemp,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** Attempt every owned cleanup, share concurrent calls, and allow failed cleanup
 * to be retried. Never let a failed bridge close skip its catalog removal. */
export function processResourceCleanup(
  ...actions: (() => void | Promise<void>)[]
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      const errors: unknown[] = [];
      for (const action of actions) {
        try {
          await action();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, "Process resource cleanup failed");
    })().catch((error) => {
      pending = undefined;
      throw error;
    }));
}

async function absentIsClean(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** One immutable catalog per prepared Core process, even in a shared CODEX_HOME.
 * The caller owns the returned lease until transport cleanup. The temporary
 * directory is exclusively created; only its two exact files and empty directory
 * may be removed. No scan, fixed-name overwrite, or recursive removal.
 */
export async function createProcessCatalog(
  stateDirectory: string,
  catalog: { models: unknown[] },
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  // Serialization may throw (for example a cycle); do it before owning a path.
  const json = JSON.stringify(catalog);
  if (json === undefined)
    throw Error("Process catalog is not JSON serializable");
  const root = await realpath(stateDirectory);
  const directory = await mkdtemp(join(root, "synora-model-catalog-"));
  const path = join(directory, "catalog.json"),
    staging = join(directory, "catalog.json.tmp");
  const cleanup = processResourceCleanup(
    () => absentIsClean(() => unlink(staging)),
    () => absentIsClean(() => unlink(path)),
    () => absentIsClean(() => rmdir(directory)),
  );
  try {
    await writeFile(staging, json, { flag: "wx", mode: 0o600 });
    // Core receives a path only after the complete file has been closed and
    // atomically published within this private, same-filesystem directory.
    await rename(staging, path);
    return { path, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Catalog creation and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
