// Test-only marketplace. Nothing is registered in a user's personal profile.
import { mkdtemp, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { managedCore } from "../../src/engine/core-runtime";
import { macosMetadataCore } from "./macos-metadata-core";

export async function ownedCatalogFixture(
  mcpEndpoint?: string,
  liveAxiomEndpoint?: string,
  metadataOnly = false,
) {
  // The separate live qualification must opt in with its explicit endpoint.
  // Existing offline catalog/OAuth checks still require loopback-only networking.
  if (
    liveAxiomEndpoint &&
    (liveAxiomEndpoint !== process.env.SYNORA_TEST_ENDPOINT ||
      !/^https?:\/\/[^?#]+\/codex\/v1$/.test(liveAxiomEndpoint))
  )
    throw Error("Explicit matching live Axiom endpoint required");
  if (
    !liveAxiomEndpoint &&
    !(process.platform === "darwin" && metadataOnly) &&
    Object.keys(networkInterfaces()).some((name) => name !== "lo")
  )
    throw Error(
      "Catalog qualification requires a loopback-only network namespace",
    );
  const directory = await mkdtemp(join(tmpdir(), "synora-core-catalog-"));
  const workspace = join(directory, "workspace");
  const name = "synora-catalog-proof";
  const plugin = join(workspace, "plugins", name);
  const marketplace = join(workspace, ".agents/plugins/marketplace.json");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  await mkdir(join(plugin, "assets"), { recursive: true });
  // Original QA plugin artwork, read by Core from its own manifest. Not a
  // substitute for any third-party brand: production always uses that catalog.
  await copyFile(
    new URL("../../public/brand/synora.svg", import.meta.url),
    join(plugin, "assets/logo.svg"),
  );
  await mkdir(join(plugin, "skills/catalog-proof"), { recursive: true });
  await writeFile(
    join(plugin, "skills/catalog-proof/SKILL.md"),
    "---\nname: catalog-proof\ndescription: Report the isolated Synora catalog qualification marker.\n---\n\nReturn SYNORA_CATALOG_PROOF when this controlled QA skill is explicitly invoked.\n",
  );
  const manifest = {
    name,
    version: "1.0.0",
    description: "Isolated Synora catalog qualification fixture",
    author: { name: "Synora QA" },
    skills: "./skills/",
    license: "MIT",
    ...(mcpEndpoint
      ? { mcpServers: { proof: { type: "http", url: mcpEndpoint } } }
      : {}),
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
  const catalog = {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [
      {
        name,
        source: { source: "local", path: `./plugins/${name}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  };
  await writeFile(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(marketplace, JSON.stringify(catalog, null, 2));
  const core = await managedCore(join(directory, "payload"));
  const metadataExecutable =
    process.platform === "darwin" && metadataOnly
      ? await macosMetadataCore(core, directory)
      : core;
  return {
    directory,
    workspace,
    plugin,
    marketplace,
    name,
    core,
    metadataExecutable,
    manifest,
    catalog,
  };
}
