import { join } from "node:path";
import { prepareMacPty } from "./prepare-native.mjs";
import { patchWindowsPty } from "./patch-windows-pty.mjs";
import { packageRuntime } from "./package-runtime.mjs";
export default async function afterPack(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          context.packager.appInfo.productFilename + ".app",
          "Contents",
          "Resources",
        )
      : join(context.appOutDir, "resources");
  // electron-builder's verified Arch enum: x64=1, arm64=3.
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
  if (!arch)
    throw new Error("No pinned Core runtime for this package architecture");
  await packageRuntime(resources, context.electronPlatformName, arch);
  if (context.electronPlatformName === "win32") {
    await patchWindowsPty(
      join(context.appOutDir, "resources/app.asar.unpacked"),
    );
    return;
  }
  if (context.electronPlatformName !== "darwin") return;
  const unpacked = join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
  );
  await prepareMacPty(unpacked);
}
