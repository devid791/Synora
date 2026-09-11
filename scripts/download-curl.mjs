import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lock from "../native/web/curl-lock.json" with { type: "json" };
import zlib from "../native/web/zlib-lock.json" with { type: "json" };
const directory = resolve("out/native-deps");
await mkdir(directory, { recursive: true });
for (const dependency of [lock, zlib]) {
  const lock = dependency;
  const path = join(directory, lock.file);
  const verify = (data) => {
    if (
      data.length !== lock.size ||
      createHash("sha256").update(data).digest("hex") !== lock.sha256
    )
      throw new Error("libcurl source size/SHA256 mismatch");
  };
  let exists = false;
  try {
    verify(await readFile(path));
    exists = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!exists) {
    const response = await fetch(lock.url, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new Error(`libcurl download HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    verify(data);
    await writeFile(path, data, { flag: "wx", mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      path,
      version: lock.version,
      sha256: lock.sha256,
      verified: true,
    }),
  );
}
