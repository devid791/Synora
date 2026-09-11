import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

test("light logo preserves approved geometry, transparency and dark master", async () => {
  const dark = await readFile("public/brand/synora.svg", "utf8");
  const light = await readFile("public/brand/synora-light.svg", "utf8");
  assert.equal(
    createHash("sha256").update(dark).digest("hex"),
    "e559caa01113aea730e90de63606ff754af256aa2f22a1f3ac8e55aea5fc9c5a",
  );
  const paths = (svg: string) =>
    [...svg.matchAll(/<path\s[^>]+>/g)].map((m) => m[0]);
  assert.deepEqual(paths(light), paths(dark));
  assert.equal(paths(light).length, 3);
  assert.equal(
    light.match(/viewBox="[^"]+"/)![0],
    dark.match(/viewBox="[^"]+"/)![0],
  );
  assert.ok(!/<(?:rect|image|foreignObject|script)\b/.test(light));
  assert.ok(!light.includes("@font-face"));
  const render = (svg: string) => {
    const r = new Resvg(svg).render();
    const pixels = r.pixels;
    assert.equal(r.width, 1437);
    assert.equal(r.height, 374);
    assert.equal(pixels[3], 0, "Transparent corner, no baked-in backdrop");
    let emblemTotal = 0,
      emblemCount = 0,
      wordmarkCount = 0;
    const colors = new Set<string>();
    for (let y = 0; y < r.height; y++)
      for (let x = 0; x < r.width; x++) {
        const i = (y * r.width + x) * 4;
        if (pixels[i + 3] !== 255) continue;
        if (x > 380) {
          colors.add([...pixels.slice(i, i + 3)].join(","));
          wordmarkCount++;
        } else {
          emblemTotal +=
            pixels[i] * 0.2126 +
            pixels[i + 1] * 0.7152 +
            pixels[i + 2] * 0.0722;
          emblemCount++;
        }
      }
    assert.ok(wordmarkCount > 2000 && emblemCount > 2000);
    return { colors: [...colors], emblem: emblemTotal / emblemCount };
  };
  const a = render(dark),
    b = render(light);
  assert.deepEqual(a.colors, ["247,248,252"]);
  assert.deepEqual(b.colors, ["21,28,39"]);
  assert.ok(
    b.emblem < a.emblem * 0.7,
    "Light-theme emblem is visibly darker, not a white mark on pale background",
  );
});
