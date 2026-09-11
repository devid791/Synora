# Public source release scope

Initial public export: 11 September 2026. Application runtime baseline:
`67eed3da471c9d3bc115c4d2a33515ee647811d8`. Later private commits contain
documentation; the export also includes current cross-platform test corrections.
Public Git history starts at this reviewed export, not the private repository.

Included: application runtime, generated pinned protocol/schema definitions,
native web helper and provenance, build prerequisites, sanitized tests, the
English user manual, MIT license and third-party notices.

Excluded: private operational/QA reports and histories, user conversations,
credentials, private network configuration, maintainer signing material,
deployment/cleanup scripts, model weights and compiled installers. Historical
test fixture paths are anonymized. The private signing-identity test is not part
of this export. Its deletion does not certify any signing identity for a public
build.

The compiled Mac Core updater retains its original qualification source/hash
pin. The raw private qualification report is not published. The public metadata
test checks the retained pin and platform boundary, not a fresh execution of
that private report. No Core qualification is transferred to another platform.

The exact downloadable packages use runtime 67eed3d, version
`0.1.0-foundation.2` (DEB package version `0.1.0~foundation.2`). Their digests:

| Package | SHA-256 |
| --- | --- |
| macOS ARM64 ZIP | dadb88946bfce491a8055512b6ff30ee98bece0a6f59e1b4c84dff0585b957ac |
| Linux amd64 DEB | c799d0635775f1349c8982a88b0dfb1c250477c672efbe34f1766644c9311fda |
| Windows x64 EXE | 8987c221bdf33dea4c2354aba44da6282546ca50df1a934f98b434ae1cea3b18 |

These binaries were not rebuilt for source publication. MIT package metadata,
public documentation and ad-hoc Mac build settings differ from their original
private build metadata; the installed Mac reference is unchanged.

## Known acceptance limits

The aligned Linux/Windows builds have a small-window/150%-zoom layout issue
with expanded navigation/update notice and an account-check busy-feedback gap.
External account grants and full platform/provider combinations are not all
qualified. Large images/context and hardware-specific performance need their
own evidence. Refer to the manual before important work.

Mac distribution is locally signed, not Developer ID notarized. Windows is
unsigned. Public-source Mac builds have a different ad-hoc identity by default.
Neither a successful build nor host-side tests establish a blanket production GO.
