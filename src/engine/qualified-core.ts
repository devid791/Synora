import { PROTOCOL_VERSION } from "../shared/contracts";
import { corePackage, legacyCorePackage, type CorePackage } from "./core-runtime";
import mac0154 from "../../docs/core-0.154.0-darwin-arm64.json" with { type: "json" };

export interface QualifiedCore {
  package: CorePackage;
  // Exact compiled protocol/adapter compatibility, not a semver assumption.
  protocol: string;
  qualification: {
    sourceCommit: string;
    evidenceSha256: string;
    checks: string[];
  };
}
export const REQUIRED_CORE_GATES = [
  "initialize",
  "axiom-turn",
  "tools",
  "sse",
  "resume",
  "cancel",
  "plugins-mcp",
  "provider-adapters",
  "native-sandbox",
  "ui",
] as const;
/** Trusted code shipped with Synora. Never populated from release notes or IPC.
 * Add a version ONLY with an independently reviewed, platform-specific receipt.
 * An incompatible protocol requires a Synora adapter/schema update first. */
export const qualifiedCoreUpdates: readonly QualifiedCore[] = [
  {
    package: mac0154 as unknown as CorePackage,
    protocol: PROTOCOL_VERSION,
    qualification: {
      sourceCommit: "85a3f4056785c51a14e25d289fe90ebd3685372a",
      evidenceSha256:
        "3c08ee65a5ee9ab644becb605c65ef05c4dbb7285ce5cfb90a49edc3f33e5fb6",
      checks: [
        "initialize",
        "axiom-turn",
        "tools",
        "sse",
        "resume",
        "cancel",
        "plugins-mcp",
        "provider-adapters",
        "native-sandbox",
        "ui",
      ],
    },
  },
];
export function qualifiedCore(version: string, key?: string): QualifiedCore {
  const bundled = corePackage(key), legacy = legacyCorePackage(key);
  if (version === bundled.version || version === legacy.version)
    return {
      package: version === bundled.version ? bundled : legacy,
      protocol: PROTOCOL_VERSION,
      qualification: {
        sourceCommit: "",
        evidenceSha256: "",
        checks: [
          "Bundled pinned baseline; platform acceptance recorded separately",
        ],
      },
    };
  const baseline = corePackage(key);
  const matches = qualifiedCoreUpdates.filter(
    (v) =>
      v.package.version === version &&
      v.package.target === baseline.target &&
      v.protocol === PROTOCOL_VERSION &&
      /^[a-f0-9]{40}$/.test(v.qualification.sourceCommit) &&
      /^[a-f0-9]{64}$/.test(v.qualification.evidenceSha256) &&
      REQUIRED_CORE_GATES.every((g) => v.qualification.checks.includes(g)),
  );
  if (matches.length !== 1)
    throw Error(
      "No uniquely qualified Core release for this Synora adapter and platform",
    );
  return matches[0];
}
export function compareCoreVersions(a: string, b: string) {
  if (
    ![a, b].every(
      (v) =>
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) &&
        v.split(".").every((n) => Number.isSafeInteger(Number(n))),
    )
  )
    throw Error("Invalid stable Core version");
  const x = a.split(".").map(Number),
    y = b.split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
