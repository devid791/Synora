import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type WindowsCoreHome = { path: string; error?: string };
const schema = "synora.windows-core-home.v1";
const relativePattern = /^(app-server\/[A-Za-z0-9_-]{1,128}|accounts\/openai)$/;

/** Original Core's elevated sandbox uses machine-wide user identities. One
 * Synora Windows installation therefore owns ONE Core home, with per-request
 * provider config. Bearer credentials and application bindings stay separate.
 * Adopt a sole pre-existing home in place: no credentials/history are copied,
 * reset, merged or deleted. Ambiguous legacy homes require explicit migration.
 */
export function windowsCoreHome(root: string): WindowsCoreHome {
  const base = resolve(root);
  const fallback = join(base, "app-server", "windows-core");
  const bindingPath = join(base, "app-server", ".windows-home.json");
  const checked = (relative: string) => {
    if (!relativePattern.test(relative))
      throw Error("Invalid Windows Core home binding");
    let path = base;
    for (const segment of relative.split("/")) {
      path = join(path, segment);
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory())
          throw Error("Windows Core home must be an owned real directory");
      }
    }
    return path;
  };
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 });
    if (lstatSync(base).isSymbolicLink())
      throw Error("Windows Core data root cannot be a link");
    checked("app-server/windows-core");
    mkdirSync(join(base, "app-server"), { recursive: true, mode: 0o700 });
    if (existsSync(bindingPath)) {
      const info = lstatSync(bindingPath);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 4096)
        throw Error("Invalid Windows Core home binding file");
      const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      if (binding.schema !== schema || typeof binding.relative !== "string")
        throw Error("Invalid Windows Core home binding document");
      const path = checked(binding.relative);
      if (!existsSync(path))
        throw Error(
          "Bound Windows Core home is missing; restore its data before continuing",
        );
      return { path };
    }
    const candidates = [
      "accounts/openai",
      ...readdirSync(join(base, "app-server"))
        .filter((name) => /^[A-Za-z0-9_-]{1,128}$/.test(name))
        .map((name) => `app-server/${name}`),
    ];
    const populated = candidates.filter((relative) => {
      const path = checked(relative);
      return existsSync(path) && readdirSync(path).length > 0;
    });
    if (populated.length > 1)
      throw Error(
        "Multiple existing Windows Core homes need a reviewed migration; no sandbox setup or data merge was performed",
      );
    const relative = populated[0] ?? "app-server/windows-core";
    const path = checked(relative);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const temporary = `${bindingPath}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schema, relative }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, bindingPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    return { path };
  } catch (error) {
    // The UI still loads; Core mutations/inference must reject this error.
    return { path: fallback, error: `Windows Core state: ${String(error)}` };
  }
}
