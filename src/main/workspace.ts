import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FileDocument, FileEntry, Workspace } from "../shared/contracts";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const digest = (buffer: Buffer | string) =>
  createHash("sha256").update(buffer).digest("hex");
export async function resolveWorkspacePath(
  workspace: Workspace,
  relative: string,
): Promise<string> {
  if (relative.includes("\0") || path.isAbsolute(relative))
    throw new Error("Use a workspace-relative path");
  const root = await fs.realpath(workspace.path);
  const target = await fs.realpath(path.resolve(root, relative));
  const within = path.relative(root, target);
  if (
    within === ".." ||
    within.startsWith(`..${path.sep}`) ||
    path.isAbsolute(within)
  )
    throw new Error("Path is outside the selected workspace");
  return target;
}
export async function listFiles(
  workspace: Workspace,
  relative: string,
): Promise<FileEntry[]> {
  const directory = await resolveWorkspacePath(workspace, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (
      entry.isSymbolicLink() ||
      entry.name === ".git" ||
      entry.name === "node_modules"
    )
      continue;
    const entryPath = path.join(directory, entry.name);
    const stat = await fs.lstat(entryPath);
    if (!stat.isFile() && !stat.isDirectory()) continue;
    result.push({
      name: entry.name,
      path: path.relative(await fs.realpath(workspace.path), entryPath),
      directory: stat.isDirectory(),
      size: stat.size,
    });
  }
  return result.sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}
export async function readFile(
  workspace: Workspace,
  relative: string,
): Promise<FileDocument> {
  const target = await resolveWorkspacePath(workspace, relative);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES)
      throw new Error("The local editor supports text files up to 2 MiB");
    const bytes = await handle.readFile();
    if (bytes.includes(0))
      throw new Error("Binary file: preview is unavailable");
    return {
      path: relative,
      content: bytes.toString("utf8"),
      revision: digest(bytes),
    };
  } finally {
    await handle.close();
  }
}
export async function saveFile(
  workspace: Workspace,
  document: FileDocument,
): Promise<FileDocument> {
  if (Buffer.byteLength(document.content) > MAX_TEXT_BYTES)
    throw new Error("The local editor supports text files up to 2 MiB");
  const current = await readFile(workspace, document.path);
  if (current.revision !== document.revision)
    throw new Error("File changed outside Synora. Reload before saving.");
  const target = await resolveWorkspacePath(workspace, document.path);
  const temp = path.join(path.dirname(target), `.synora-save-${randomUUID()}`);
  const mode = (await fs.stat(target)).mode & 0o777;
  try {
    const handle = await fs.open(temp, "wx", mode);
    try {
      await handle.writeFile(document.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (
      (await readFile(workspace, document.path)).revision !== document.revision
    )
      throw new Error("Concurrent edit detected; save cancelled");
    await fs.rename(temp, target);
    return {
      path: document.path,
      content: document.content,
      revision: digest(document.content),
    };
  } finally {
    await fs.unlink(temp).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
