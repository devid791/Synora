// Extract original runner PNG bytes for visual review; no cropping/repainting.
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
const [reportPath, ...wanted] = process.argv.slice(2);
if (!reportPath || !wanted.length)
  throw Error("Specify report and exact attachment names");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const output = await mkdtemp("out/live-evidence/visual-review-");
const found = [];
async function visit(value) {
  if (!value || typeof value !== "object") return;
  if (value.contentType === "image/png" && wanted.includes(value.name)) {
    if (!value.body) throw Error("Expected an embedded original screenshot");
    const bytes = Buffer.from(value.body, "base64");
    if (
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw Error("Invalid PNG");
    const path = join(output, `original-${found.length + 1}.png`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    found.push({
      name: value.name,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  for (const child of Object.values(value))
    if (typeof child === "object") await visit(child);
}
await visit(report);
for (const name of wanted)
  if (!found.some((a) => a.name === name))
    throw Error(`Missing attachment: ${name}`);
console.log(JSON.stringify({ reportPath, output, found }));
