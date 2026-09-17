# Synora 0.2.3 qualification scope

Application source: `a05411710f0e30992e91a8ee0bded10a07068bf8`.
Publication-only commits may follow; they do not rebuild these binaries.
Bundled Core: 0.154.0; recovery: 0.153.4.

## Passed

- 767 automated tests, zero failed/skipped; TypeScript typecheck.
- 12 transport tests executed natively on the MacBook, including preservation
  of real permission failures and cleanup of live owned descendants.
- Web functional tests: 2/2. Responsive, keyboard and dialog checks: 4/4,
  including a 390px viewport.
- All desktop artifacts: exact compiled-source comparison, pinned Core hashes,
  native helper provenance, version, and private-path/credential exclusion.
- MacBook signed bundle, installed Windows EXE on Axiom Builder, and Linux
  packaged application: each displayed six real RTX 5090 hardware samples.
- Extracted Linux x64 web archive, outside the source checkout: 750-file
  manifest, launch, host/session boundary, real file read/write, native PTY,
  bundled browser input, and isolated Core initialization.

## Not a complete production GO

The complete [native Core qualification run](https://github.com/devid791/Synora/actions/runs/35280843292)
does **not** pass all gates. The Mac and Linux live search/fetch tests failed:
configured upstream search providers returned rate limits/CAPTCHAs; a Bing
fallback returned unrelated results when a language filter was supplied.
These are real failed live tests, not converted to passes or replaced by mocks.
The model's attempts to find a relevant page are not evidence of successful
search. Ordinary inference and tool tests are separate from that dependency.

No candidate can be authorized by the signed Core update publisher unless all
three native platform reports pass every required gate. A failed qualification
leaves the previous channel intact; bundled Core remains usable. This release
therefore remains a preview, with the external search dependency explicitly
unqualified. It is not certification of every plugin, account or computer.

## Deployment boundaries

- macOS: Apple silicon, locally signed with the existing identity; not Apple
  notarized. OS/Keychain approvals cannot be overridden by an app permission.
- Windows: x64 unsigned installer; native sandbox prerequisites still apply.
- Linux desktop: Debian-compatible amd64 distribution.
- Web package: Linux x64, Node.js 22.19+ and Chromium shared libraries required.
  The service is local-only; do not expose its native tools on the internet.
- Core channel updates Core only, not the Synora app or model weights.
- MacBook replacement preserves the user's profile, conversations and keys.
  Mac Mini was unreachable and is **not** claimed as updated. Windows testing
  was on Axiom Builder, not an uninspected office PC.

## Fixed process ownership regressions

The idle reconnect race was reproduced before correction: an asynchronous
background context read could replace an active foreground transport. The
engine now rechecks ownership after the await.

POSIX cleanup keeps ownership of the spawned process group after leader exit.
On Darwin, a group permission error is dismissed only after an independent
process-table check proves that the leader has exited and no live member
remains. A live member or failed observation preserves the original error.
Apple's [XNU group-signal implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c)
filters zombie members before deciding whether a group signal found a target.

Exact distribution hashes are published in the release's `SHA256SUMS.txt`.
