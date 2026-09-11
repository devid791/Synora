import { randomUUID, createHash } from "node:crypto";
import { constants, realpathSync, readdirSync, lstatSync, readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { mkdir, realpath, open, unlink, lstat, readdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import {
  imageUploadSchema,
  imageAttachmentSchema,
  MAX_IMAGE_BYTES,
  type ImageAttachment,
  type ImageUpload,
} from "../shared/image-attachments";

const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export function imageBytes(input: ImageUpload) {
  const value = imageUploadSchema.parse(input);
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value.dataUrl,
    );
  if (!match)
    throw Error(
      "Choose a PNG, JPEG or WebP image; URLs and SVG are not image uploads",
    );
  const bytes = Buffer.from(match[2], "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== match[2]
  )
    throw Error("Invalid image encoding or image exceeds 8 MiB upload bound");
  const mime = match[1] as ImageAttachment["mime"];
  const signature =
    mime === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
  if (!signature) throw Error("Image bytes do not match their declared format");
  return { bytes, mime, name: value.name };
}

/** Only registered, installation-owned images can become Core localImage paths. */
export class ImageAttachments {
  constructor(private root: string) {
    const absolute = resolve(root);
    // Match fs.promises.realpath's native spelling, including Windows 8.3
    // names and macOS /var or /tmp aliases. Canonicalize only the existing
    // state parent; root/directory/file link checks below remain exact.
    this.root = join(
      realpathSync.native(dirname(absolute)),
      basename(absolute),
    );
  }
  path(conversationId: string, image: ImageAttachment) {
    imageAttachmentSchema.parse(image);
    const extension = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
    }[image.mime];
    return join(this.root, digest(conversationId), `${image.id}.${extension}`);
  }
  private async directory(conversationId: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await realpath(this.root)) !== this.root)
      throw Error("Image storage must not be linked");
    const dir = join(this.root, digest(conversationId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if ((await realpath(dir)) !== dir)
      throw Error("Image conversation storage must not be linked");
  }
  async add(conversationId: string, input: ImageUpload) {
    const { bytes, mime, name } = imageBytes(input);
    await this.directory(conversationId);
    const image: ImageAttachment = {
      id: randomUUID(),
      name,
      mime,
      bytes: bytes.length,
      sha256: digest(bytes),
    };
    const path = this.path(conversationId, image);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      // Only our exclusively-created file is eligible for rollback. A failed
      // upload must not leave an unregistered partial image occupying disk.
      try {
        await unlink(path);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Image upload and cleanup failed",
        );
      }
      throw error;
    }
    return image;
  }
  async read(conversationId: string, image: ImageAttachment) {
    await this.directory(conversationId);
    const path = this.path(conversationId, image);
    if ((await realpath(path)) !== path)
      throw Error("Image file must not be linked");
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size !== image.bytes ||
        stat.size > MAX_IMAGE_BYTES
      )
        throw Error("Stored image size changed");
      const bytes = await file.readFile();
      if (digest(bytes) !== image.sha256)
        throw Error("Stored image contents changed");
      return {
        path,
        dataUrl: `data:${image.mime};base64,${bytes.toString("base64")}`,
      };
    } finally {
      await file.close();
    }
  }
  async remove(conversationId: string, image: ImageAttachment) {
    await this.read(conversationId, image);
    await unlink(this.path(conversationId, image));
  }
  /** Stage only this installation-owned, registered image directory. The caller
   * commits SQLite before purging; a database failure restores the image paths. */
  async stageConversationRemoval(conversationId: string, images: ImageAttachment[]) {
    const dir = join(this.root, digest(conversationId));
    const noop = { rollback: async () => {}, purge: async () => {} };
    try { await lstat(dir); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return noop;
      throw e;
    }
    if ((await realpath(this.root)) !== this.root || (await realpath(dir)) !== dir || !(await lstat(dir)).isDirectory())
      throw Error("Image conversation storage must be an owned, unlinked directory");
    const registered = new Map(images.map(image => [basename(this.path(conversationId, image)), image]));
    for (const entry of await readdir(dir)) {
      const image = registered.get(entry);
      if (!image) throw Error("Unexpected image file; conversation was not deleted");
      await this.read(conversationId, image);
    }
    const batch = await mkdtemp(join(this.root, ".delete-"));
    const staged = join(batch, "attachments");
    try {
      const journal = await open(join(batch, "removal.json"), "wx", 0o600);
      try { await journal.writeFile(JSON.stringify({ version: 1, conversationId })); await journal.sync(); }
      finally { await journal.close(); }
      await rename(dir, staged);
    } catch (e) { await rm(batch, { recursive: true }); throw e; }
    return {
      rollback: async () => { await rename(staged, dir); await rm(batch, { recursive: true }); },
      // Exclusive staging leaf, never the image root, user workspace or source.
      purge: async () => { await rm(batch, { recursive: true }); },
    };
  }
  /** Crash recovery uses the committed SQLite membership, never guesses whether
   * a moved attachment belonged to a successfully deleted conversation. */
  recoverConversationRemovals(existingIds: Set<string>) {
    if (!existsSync(this.root)) return;
    if (realpathSync.native(this.root) !== this.root) throw Error("Linked image storage");
    for (const name of readdirSync(this.root).filter(n => /^\.delete-[A-Za-z0-9]{6}$/.test(n))) {
      const batch = join(this.root, name), journal = join(batch, "removal.json"), staged = join(batch, "attachments");
      if (!lstatSync(batch).isDirectory() || realpathSync.native(batch) !== batch) throw Error("Invalid image deletion staging directory");
      // A crash before journal creation has not moved any original files.
      if (!existsSync(journal)) { if (!readdirSync(batch).length) rmSync(batch, { recursive: true }); continue; }
      const stat = lstatSync(journal);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw Error("Invalid image deletion journal");
      const record = JSON.parse(readFileSync(journal, "utf8"));
      if (record.version !== 1 || typeof record.conversationId !== "string" || !record.conversationId.length || record.conversationId.length > 160)
        throw Error("Invalid image deletion identity");
      if (readdirSync(batch).some(n => !["removal.json", "attachments"].includes(n))) throw Error("Unexpected deletion staging file");
      if (existsSync(staged)) {
        if (!lstatSync(staged).isDirectory() || realpathSync.native(staged) !== staged) throw Error("Invalid staged images");
        if (existingIds.has(record.conversationId)) {
          const original = join(this.root, digest(record.conversationId));
          if (existsSync(original)) throw Error("Image recovery destination already exists");
          renameSync(staged, original);
        }
      }
      rmSync(batch, { recursive: true });
    }
  }
}
