// QA only. Reuse original Core and the verified native launcher, never setup.
// This is NOT a replacement for OS-enforced egress denial. Missing/stale proof
// fails before any Core/app launch, fixture mutation or credential operation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { sha256File } from "../../src/engine/core-runtime";
import { assertControlledNetwork } from "./controlled-network";
import { controlledCoreLauncher } from "./controlled-core-launcher";

const CORE_SHA256 =
  "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b";
const LAUNCHER_SHA256 =
  "0aa86256dfefca827dc8973dcd6338dafa07647c33e3a7f36e2354b9aa105fc8";
const PREPARED =
  "C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-Mb5PPy";
const core = join(
  PREPARED,
  "state",
  "core-runtime",
  "0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a",
  "bin",
  "codex.exe",
);

function samePath(a: string, b: string) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}
function inside(root: string, target: string) {
  const r = relative(root, target);
  assert.ok(
    r && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r),
    "QA target must be inside its exact new root",
  );
}
async function regular(path: string) {
  const s = await lstat(path);
  assert.ok(s.isFile() && !s.isSymbolicLink(), "Expected a regular QA file");
  assert.ok(samePath(await realpath(path), path), "Linked QA file rejected");
}

export async function windowsFinalMetadataAdmission() {
  assert.equal(
    process.platform,
    "win32",
    "Windows-only metadata admission; no platform substitution",
  );
  const qaRoot = process.env.SYNORA_WINDOWS_FINAL_QA_ROOT ?? "";
  assert.match(qaRoot, /^C:\\Synora_QA_final_[0-9]{8}_[a-f0-9]{12}$/);
  assert.ok(samePath(await realpath(qaRoot), qaRoot));
  assert.ok(
    samePath(process.cwd(), qaRoot),
    "Use the frozen new QA working directory",
  );
  const executable = process.env.SYNORA_TEST_EXECUTABLE ?? "";
  assert.ok(
    isAbsolute(executable),
    "A packaged executable is required; no development fallback",
  );
  inside(qaRoot, executable);
  assert.match(executable, /\\win-unpacked\\Synora Harness Desktop\.exe$/);
  await regular(executable);
  const asar = join(dirname(executable), "resources", "app.asar");
  await regular(asar);
  const expected = process.env.SYNORA_WINDOWS_FINAL_ASAR_SHA256 ?? "";
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(await sha256File(asar), expected, "Packaged ASAR changed");
  const commit = process.env.SYNORA_WINDOWS_FINAL_SOURCE_COMMIT ?? "";
  assert.match(commit, /^[a-f0-9]{40}$/);
  const source = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        [
          "scripts/source-receipt.mjs",
          "verify",
          "out/compiled-source-receipt.json",
        ],
        { timeout: 30000, maxBuffer: 65536 },
      )
    ).stdout,
  );
  assert.equal(source.commit, commit);
  assert.ok(source.files > 0);
  assert.deepEqual(source.mismatches, []);

  // Executes the existing read-only Verify action and actual denied TCP/UDP
  // probes. Does not install a rule, refresh proof, or invoke Run/Cleanup.
  await assertControlledNetwork();
  const proofPath = process.env.SYNORA_QA_NETWORK_PROOF!;
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.schema, "synora.qa-windows-network.v1");
  assert.equal(proof.files.length, 3);
  assert.ok(samePath(proof.files[0].path, process.execPath));
  assert.ok(
    samePath(proof.files[1].path, executable),
    "Proof must isolate this packaged EXE, not development Electron",
  );
  assert.ok(
    samePath(proof.files[2].path, core),
    "Proof must isolate original prepared Core",
  );
  assert.ok(proof.expires > Date.now());
  await regular(core);
  assert.equal(await sha256File(core), CORE_SHA256);
  const launcher = process.env.SYNORA_QA_CORE_LAUNCHER ?? "";
  assert.ok(isAbsolute(launcher));
  await regular(launcher);
  assert.equal(
    await sha256File(launcher),
    LAUNCHER_SHA256,
    "Use the previously qualified unmodified native launcher",
  );
  return {
    qaRoot,
    executable,
    asar,
    asarSha256: expected,
    source,
    core,
    coreSha256: CORE_SHA256,
    launcherSha256: LAUNCHER_SHA256,
    proofPath,
    proofId: proof.id as string,
    proofExpires: proof.expires as number,
  };
}

export async function windowsFinalMetadataFixture(withPlugin: boolean) {
  const admission = await windowsFinalMetadataAdmission();
  const directory = await mkdtemp(
    join(tmpdir(), "synora-windows-final-metadata-"),
  );
  const workspace = join(directory, "workspace"),
    dataRoot = join(directory, "state");
  await mkdir(workspace);
  await mkdir(dataRoot);
  // Metadata/account operations do not need a native tool sandbox. A fresh
  // empty home avoids reading/mutating any preserved app or sandbox credentials.
  // No nativeToolSetup, thread/turn/command or external browser call is made.
  const accountHome = join(dataRoot, "app-server", "windows-core");
  const metadataExecutable = await controlledCoreLauncher(
    directory,
    admission.core,
  );
  assert.equal(await sha256File(metadataExecutable), admission.launcherSha256);
  const name = "synora-catalog-proof",
    plugin = join(workspace, "plugins", name);
  const marketplace = join(workspace, ".agents", "plugins", "marketplace.json");
  const manifest = {
    name,
    version: "1.0.0",
    description: "Isolated Synora catalog qualification fixture",
    author: { name: "Synora QA" },
    skills: "./skills/",
    license: "MIT",
    interface: {
      logo: "./assets/logo.svg",
      logoDark: "./assets/logo.svg",
      displayName: "Synora Catalog Proof",
      shortDescription: "Original Core discovery qualification",
      longDescription:
        "A local test-only skill plugin. No external accounts, background actions or network tools.",
      category: "Productivity",
    },
  };
  if (withPlugin) {
    await mkdir(join(workspace, ".git"));
    await mkdir(dirname(marketplace), { recursive: true });
    await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
    await mkdir(join(plugin, "assets"));
    await mkdir(join(plugin, "skills", "catalog-proof"), { recursive: true });
    await copyFile(
      join(admission.qaRoot, "public", "brand", "synora.svg"),
      join(plugin, "assets", "logo.svg"),
    );
    await writeFile(
      join(plugin, "skills", "catalog-proof", "SKILL.md"),
      "---\nname: catalog-proof\ndescription: Report the isolated Synora catalog qualification marker.\n---\n\nReturn SYNORA_CATALOG_PROOF when this controlled QA skill is explicitly invoked.\n",
      { flag: "wx" },
    );
    await writeFile(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify(manifest, null, 2),
      { flag: "wx" },
    );
    await writeFile(
      marketplace,
      JSON.stringify(
        {
          name: "personal",
          interface: { displayName: "Personal" },
          plugins: [
            {
              name,
              source: { source: "local", path: `./plugins/${name}` },
              policy: {
                installation: "AVAILABLE",
                authentication: "ON_INSTALL",
              },
              category: "Productivity",
            },
          ],
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
  }
  return {
    ...admission,
    directory,
    workspace,
    dataRoot,
    accountHome,
    metadataExecutable,
    name,
    plugin,
    marketplace,
    manifest,
  };
}

export type WindowsFinalMetadataFixture = Awaited<
  ReturnType<typeof windowsFinalMetadataFixture>
>;

export async function retainWindowsFinalMetadataReceipt(
  fixture: WindowsFinalMetadataFixture,
  gate: "account" | "catalog" | "plugin",
  detail: Record<string, unknown>,
) {
  // Recheck proof/identities at completion; expiration or a changed executable
  // is a failure, not an offline pass. Raw failures/traces are retained by PW.
  const after = await windowsFinalMetadataAdmission();
  assert.equal(after.proofId, fixture.proofId);
  await mkdir("out/live-evidence", { recursive: true });
  await writeFile(
    join(
      "out/live-evidence",
      `windows-final-metadata-${gate}-${Date.now()}.json`,
    ),
    JSON.stringify(
      {
        schema: "synora.windows-final-metadata.v1",
        passed: true,
        gate,
        at: new Date().toISOString(),
        scope:
          "Original Core packaged Windows metadata/account/plugin only; verified external egress denial; no inference, public grant or production qualification",
        directory: fixture.directory,
        executable: fixture.executable,
        asarSha256: fixture.asarSha256,
        source: fixture.source,
        coreSha256: fixture.coreSha256,
        launcherSha256: fixture.launcherSha256,
        proofId: fixture.proofId,
        proofExpires: fixture.proofExpires,
        detail,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
