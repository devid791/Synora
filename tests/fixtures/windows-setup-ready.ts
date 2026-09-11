// Fresh original Core prerequisite check against an already-prepared QA home.
// No setupStart, no inference, no credential reading or setup duplication.
import { nativeToolSetup } from "../../src/engine/windows-setup";
import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
const [input, binary] = process.argv.slice(2);
if (process.platform !== "win32" || !input || !binary)
  throw Error("Windows QA directory and exact Core executable required");
const directory = resolve(input);
if (
  !/^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/.test(
    directory,
  )
)
  throw Error("Not an owned isolated native QA directory");
await stat(join(directory, "workspace", "native-check.txt"));
const result = await nativeToolSetup({
  executable: resolve(binary),
  stateDirectory: join(directory, "state", "app-server", "native-axiom"),
  cwd: join(directory, "workspace"),
});
console.log(
  JSON.stringify({ at: new Date().toISOString(), directory, result }),
);
if (result.status !== "ready") process.exitCode = 1;
