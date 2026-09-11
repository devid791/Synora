# Public source checks — 11 September 2026

Checks ran on the isolated public export, without replacing either installed Mac
application or altering the production Axiom service.

| Check | Result and scope |
| --- | --- |
| Runtime/protocol/native/brand input comparison | 1,214 files byte-identical to the reference source; no runtime edits |
| TypeScript | Pass |
| Default host-side suite | 643 passed, 0 failed, 0 skipped |
| Desktop build | Pass |
| Local web build | Pass |
| Native web/MCP helper | Linux x64 compile and source/hash receipt pass; no tool execution implied |
| Gitleaks | No findings in the exported tree |
| User manual | 25 chapters; Markdown matches website version; links and local search tests pass |

An initial host-side run failed to load node-pty after dependencies were
deliberately installed with lifecycle scripts disabled. Running the pinned
node-pty/Electron rebuild prepared the native dependency; the unchanged tests
then passed. This was an export-environment prerequisite, not an installed-app
bug or a runtime fix.

The builds report a large-client-chunk warning, retained rather than hidden.
No new native graphical QA, public account qualification, model inference or
production release acceptance is claimed by these source-publication checks.
See RELEASE.md for the historical metadata test and omitted private evidence.
