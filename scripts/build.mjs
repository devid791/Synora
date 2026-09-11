import { build as bundle } from "esbuild";
import { build as vite } from "vite";
await vite({
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
});
await bundle({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  target: "node22",
  external: ["electron", "node-pty"],
});
await bundle({
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/preload.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  target: "node22",
  external: ["electron"],
});
