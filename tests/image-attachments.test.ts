import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  unlink,
  symlink,
  mkdir,
  readdir,
  open,
  rename,
  lstat,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { ImageAttachments, imageBytes } from "../src/main/image-attachments";
import { Store } from "../src/main/store";
import { validateOperation } from "../src/shared/operations";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=",
  "base64",
);
const upload = {
  name: "scene.png",
  dataUrl: `data:image/png;base64,${png.toString("base64")}`,
};

test("Image uploads retain original bytes and reject URLs, SVG, forged formats and malformed base64", () => {
  assert.deepEqual(imageBytes(upload).bytes, png);
  for (const dataUrl of [
    "https://example.org/image.png",
    "file:///etc/passwd",
    "data:image/svg+xml;base64,PHN2Zz4=",
    upload.dataUrl.replace("png", "jpeg"),
    "data:image/png;base64,AAAA=",
    "data:image/png;base64,%%%",
  ])
    assert.throws(() => imageBytes({ ...upload, dataUrl }));
  assert.throws(() =>
    validateOperation("imageAttach", [
      "owned",
      { ...upload, path: "/etc/passwd" },
    ]),
  );
  assert.throws(() =>
    validateOperation("imageRead", ["owned", "../../escape"]),
  );
});

test("Registered image cache verifies ownership, hashes, tampering and exact removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-test-"));
  const cache = new ImageAttachments(join(dir, "images"));
  try {
    const image = await cache.add("owned", upload);
    assert.equal((await cache.read("owned", image)).dataUrl, upload.dataUrl);
    assert.deepEqual(await readFile(cache.path("owned", image)), png);
    await assert.rejects(cache.read("another", image), /ENOENT/);
    await writeFile(cache.path("owned", image), Buffer.alloc(png.length));
    await assert.rejects(cache.read("owned", image), /contents changed/);
    await writeFile(cache.path("owned", image), png);
    await cache.remove("owned", image);
    await assert.rejects(readFile(cache.path("owned", image)), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("Image draft metadata survives SQLite restart without putting binary data in snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-state-"));
  const cache = new ImageAttachments(join(dir, "images"));
  let store = new Store(join(dir, "state.sqlite"));
  try {
    const c = store.conversation(null);
    const image = await cache.add(c.id, upload);
    store.update((s) => {
      s.conversations[0].attachments = [image];
      s.conversations[0].draftImageIds = [image.id];
    });
    store.close();
    store = new Store(join(dir, "state.sqlite"));
    const restored = store.read().conversations[0];
    assert.deepEqual(restored.attachments, [image]);
    assert.deepEqual(restored.draftImageIds, [image.id]);
    assert.equal(
      JSON.stringify(restored).includes(png.toString("base64")),
      false,
    );
    assert.equal((await cache.read(c.id, image)).dataUrl, upload.dataUrl);
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});

test("Image cache rejects linked storage instead of following it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-link-"));
  const cache = new ImageAttachments(join(dir, "images"));
  try {
    const image = await cache.add("owned", upload),
      file = cache.path("owned", image),
      target = join(dir, "outside.png");
    await writeFile(target, png);
    if (process.platform === "win32") {
      const root = join(dir, "linked-images");
      await symlink(join(dir, "images"), root, "junction");
      await assert.rejects(
        new ImageAttachments(root).read("owned", image),
        /must not be linked/,
      );
    } else {
      await unlink(file);
      await symlink(target, file);
      await assert.rejects(cache.read("owned", image), /must not be linked/);
    }
    assert.deepEqual(await readFile(target), png);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("Image cache accepts a canonical state-parent alias without following linked image storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-alias-"));
  try {
    const original = join(dir, "state"),
      alias = join(dir, "alias");
    await mkdir(original);
    await symlink(
      original,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const cache = new ImageAttachments(join(alias, "images"));
    const image = await cache.add("owned", upload);
    assert.equal((await cache.read("owned", image)).dataUrl, upload.dataUrl);
    assert.equal(
      cache.path("owned", image),
      new ImageAttachments(join(original, "images")).path("owned", image),
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("Image cache uses native state-parent spelling across add, cold read and removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-native-parent-"));
  try {
    // In the Windows limited desktop, tmpdir() contains AXIOM-~1. Legacy
    // realpathSync preserves that spelling; native/async realpath expands it.
    // Neither the fixture nor the implementation overrides TMP/TEMP.
    const cache = new ImageAttachments(join(dir, "images"));
    const image = await cache.add("owned", upload);
    const cold = new ImageAttachments(join(realpathSync.native(dir), "images"));
    assert.equal(cache.path("owned", image), cold.path("owned", image));
    assert.equal(
      cache.path("owned", image),
      realpathSync.native(cache.path("owned", image)),
    );
    assert.equal((await cold.read("owned", image)).dataUrl, upload.dataUrl);
    await cold.remove("owned", image);
    await assert.rejects(cache.read("owned", image), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

for (const level of ["root", "conversation"] as const) {
  test(`Image cache rejects ${level} redirects for add, read and remove without touching the target`, async () => {
    const dir = await mkdtemp(
      join(tmpdir(), `synora-image-${level}-redirect-`),
    );
    try {
      const root = join(dir, "images");
      const cache = new ImageAttachments(root);
      const image = await cache.add("owned", upload);
      const path = cache.path("owned", image);
      const redirected = level === "root" ? root : dirname(path);
      const target = join(dir, "outside-storage");
      await rename(redirected, target);
      await symlink(
        target,
        redirected,
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.equal((await lstat(redirected)).isSymbolicLink(), true);
      const targetFile =
        level === "root"
          ? join(target, basename(dirname(path)), basename(path))
          : join(target, basename(path));
      const before = await readdir(target);
      for (const current of [cache, new ImageAttachments(root)]) {
        await assert.rejects(
          current.add("owned", upload),
          /must not be linked/,
        );
        await assert.rejects(
          current.read("owned", image),
          /must not be linked/,
        );
        await assert.rejects(
          current.remove("owned", image),
          /must not be linked/,
        );
      }
      assert.deepEqual(await readFile(targetFile), png);
      assert.deepEqual(await readdir(target), before);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
}

test("Image cache rejects a substituted image symlink without reading or removing its target", async () => {
  // Windows file symlinks require the existing privileged CPU-test token;
  // never grant privileges, enable Developer Mode, or substitute a weaker test.
  const dir = await mkdtemp(join(tmpdir(), "synora-image-file-redirect-"));
  try {
    const cache = new ImageAttachments(join(dir, "images"));
    const image = await cache.add("owned", upload);
    const file = cache.path("owned", image);
    const target = join(dir, "outside.png");
    await writeFile(target, png, { flag: "wx" });
    await unlink(file);
    await symlink(target, file, "file");
    await assert.rejects(cache.read("owned", image), /must not be linked/);
    await assert.rejects(cache.remove("owned", image), /must not be linked/);
    assert.deepEqual(await readFile(target), png);
    assert.equal((await lstat(file)).isSymbolicLink(), true);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("Failed image writes remove only the exclusively-created partial file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-image-write-failure-"));
  const handle = await open(join(dir, "unrelated.txt"), "wx");
  try {
    await handle.writeFile("retained");
    await handle.close();
    const method = t.mock.method(
      Object.getPrototypeOf(handle),
      "writeFile",
      async () => {
        throw Error("injected image disk write failure");
      },
    );
    const root = join(dir, "images");
    await assert.rejects(
      new ImageAttachments(root).add("owned", upload),
      /injected image disk write failure/,
    );
    method.mock.restore();
    const children = await readdir(root);
    assert.equal(children.length, 1);
    assert.deepEqual(await readdir(join(root, children[0])), []);
    assert.equal(
      await readFile(join(dir, "unrelated.txt"), "utf8"),
      "retained",
    );
  } finally {
    t.mock.restoreAll();
    await handle.close();
    await rm(dir, { recursive: true });
  }
});
