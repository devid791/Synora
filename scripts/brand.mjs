import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

// Derive the OS icon from the approved vector. No shape, material or color changes.
const source = await readFile(
  new URL("../public/brand/synora.svg", import.meta.url),
  "utf8",
);
if (
  createHash("sha256").update(source).digest("hex") !==
  "e559caa01113aea730e90de63606ff754af256aa2f22a1f3ac8e55aea5fc9c5a"
)
  throw new Error(
    "Approved brand source changed; inspect before regenerating the icon.",
  );
// Application-only light variant. The approved master and OS icon stay intact;
// only material colors/opacity differ, never outlines, viewBox or typography.
const lightPalette = new Map([
  ["#98a3b1", "#405366"],
  ["#c1cbd7", "#536779"],
  ["#e4eaf0", "#6b7e90"],
  ["#f1f4f7", "#8193a3"],
  ["#d4dde7", "#5a7186"],
  ["#b4d3e9", "#63849e"],
  ["#799fc2", "#3a5c7b"],
  ["#55769e", "#254660"],
  ["#3e5c85", "#19374f"],
  ["#496d96", "#254c69"],
  ["#f7f8fc", "#151c27"],
  ["#f0f6ff", "#667c91"],
  ["#cfe8fc", "#557a97"],
]);
const light = source
  .replace(/#[a-f0-9]{6}\b/g, (color) => lightPalette.get(color) ?? color)
  .replace('stop-opacity=".7"', 'stop-opacity=".18"')
  .replace('stop-opacity=".23"', 'stop-opacity=".12"')
  .replace('stop-opacity=".88"', 'stop-opacity=".24"')
  .replace('stop-opacity=".36"', 'stop-opacity=".12"')
  .replace('stroke-opacity=".55"', 'stroke-opacity=".35"')
  .replace('stroke-opacity=".65"', 'stroke-opacity=".45"')
  .replace(
    "Synora — silver and blue titanium",
    "Synora — graphite and blue titanium",
  );
await writeFile(
  new URL("../public/brand/synora-light.svg", import.meta.url),
  light,
);
const icon = source
  .replace(
    'width="1437" height="374" viewBox="132 275 1437 374"',
    'width="1024" height="1024" viewBox="87 262 400 400"',
  )
  .replace(/\s*<use id="synora-wordmark"[^>]*\/>/, "");
const rendered = new Resvg(icon).render();
if (rendered.width !== 1024 || rendered.height !== 1024)
  throw new Error("Incorrect icon dimensions");
await writeFile(
  new URL("../public/brand/icon.png", import.meta.url),
  rendered.asPng(),
);
