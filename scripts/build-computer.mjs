import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
if (process.platform === "darwin") {
  await mkdir("dist", { recursive: true });
  execFileSync(
    "/usr/bin/clang++",
    [
      "-std=c++17",
      "-fobjc-arc",
      "-O2",
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      "native/computer-macos.mm",
      "-o",
      "dist/synora-computer-macos",
    ],
    { stdio: "inherit" },
  );
}
