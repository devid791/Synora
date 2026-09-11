// Test-only network isolation for metadata/account flows, never inference.
// Wrapping an inference Core would conflict with its nested command sandbox.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const run = promisify(execFile);
const profile =
  '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*") (remote unix-socket))';
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

export async function macosMetadataCore(core: string, directory: string) {
  if (process.platform !== "darwin") throw Error("macOS metadata fixture only");
  // Test the actual policy, not an environment flag or a guessed NIC name.
  // A timeout/unreachable route is NOT evidence of an enforced network deny.
  const probe = await run(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      profile,
      process.execPath,
      "--input-type=module",
      "-e",
      `import net from 'node:net';
     const s=net.connect({host:'192.0.2.1',port:443});
     s.setTimeout(500,()=>{s.destroy();process.exitCode=1});
     s.on('connect',()=>{s.destroy();process.exitCode=1});
     s.on('error',e=>{if(e.code==='EPERM')console.log('ENFORCED_NETWORK_DENY');else process.exitCode=1});`,
    ],
    { timeout: 3000, maxBuffer: 65536 },
  );
  if (probe.stdout.trim() !== "ENFORCED_NETWORK_DENY")
    throw Error("macOS did not enforce the metadata fixture network policy");
  const wrapper = join(directory, "metadata-only-core.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(core)} "$@"\n`,
    { mode: 0o700, flag: "wx" },
  );
  return wrapper;
}
