import { build as bundle } from "esbuild";
import { build as vite } from "vite";
await vite({
  base: "/",
  plugins: [
    {
      name: "synora-local-web-csp",
      transformIndexHtml: (html) =>
        html.replace("connect-src 'none'", "connect-src 'self'"),
    },
  ],
  build: { outDir: "out/web/ui", emptyOutDir: true },
});
await bundle({
  entryPoints: ["src/web/main.ts"],
  outfile: "out/web/server.mjs",
  platform: "node",
  format: "esm",
  bundle: true,
  target: "node22",
  external: ["node-pty", "playwright-core"],
});
