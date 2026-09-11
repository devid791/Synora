import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Original native thinking blocks survive Core-owned history and cold restart.
 * Opaque Responses encrypted_content is actually sealed, never fake base64
 * encryption. Key is installation-owned, not an account credential. */
export class NativeHistory {
  constructor(
    private key: Buffer,
    private domain: string,
    private provider: "anthropic" | "gemini" | "mistral" = "anthropic",
  ) {
    if (key.length !== 32) throw Error("Invalid native history key");
  }
  seal(value: unknown) {
    const plain = Buffer.from(JSON.stringify(value));
    // Never emit successful output with history that cannot be restored.
    if (plain.length + 28 > 8 * 1024 * 1024)
      throw Error("Native history exceeds the sealed block memory bound");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(this.domain));
    const bytes = Buffer.concat([cipher.update(plain), cipher.final()]);
    return `synora-${this.provider}-v1:${Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url")}`;
  }
  restore(value: unknown): unknown {
    if (
      typeof value !== "string" ||
      !new RegExp(`^synora-${this.provider}-v1:[A-Za-z0-9_-]+$`).test(value)
    )
      throw Error("History is not an original Synora native block");
    try {
      const bytes = Buffer.from(
        value.slice(`synora-${this.provider}-v1:`.length),
        "base64url",
      );
      if (bytes.length < 29 || bytes.length > 8 * 1024 * 1024) throw Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(this.domain));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      throw Error("Cannot authenticate native history for this provider/model");
    }
  }
  static async load(
    directory: string,
    endpoint: string,
    model: string,
    provider: "anthropic" | "gemini" | "mistral" = "anthropic",
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${provider}-history.key`);
    const temporary = join(
      directory,
      `.${provider}-history-${randomBytes(16).toString("hex")}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(randomBytes(32));
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Publish only the complete key; concurrent preparations cannot read a
      // partially written key or replace the winner's history identity.
      await link(temporary, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      await handle?.close();
      await unlink(temporary).catch((e) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
    const reader = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await reader.stat();
      if (
        !stat.isFile() ||
        stat.size !== 32 ||
        (process.platform !== "win32" && stat.mode & 0o077)
      )
        throw Error("Invalid or non-private native history key");
      return new NativeHistory(
        await reader.readFile(),
        JSON.stringify([`synora-${provider}-v1`, endpoint, model]),
        provider,
      );
    } finally {
      await reader.close();
    }
  }
}
