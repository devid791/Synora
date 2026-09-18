# GitLab Core qualification

## Requirement CORE-CI-PLATFORM-ISOLATION

GitLab at `gitlab.synapsecorp.org/davide/synora` owns Core discovery,
qualification and publication. GitHub remains a public source/download mirror.
The protected `codex/core-update-channel` branch holds the imported release source;
the pre-existing unrelated `main` product-contract history is not overwritten.

Three independent pipelines/schedules select `CORE_PLATFORM=linux`, `mac`, or
`win`. Each discovers, qualifies and publishes independently. An unavailable or
failed worker cannot hold another platform's publication. Schedules run every
six hours at minutes 03, 23 and 43 to reduce shared inference-backend contention.
Per-platform resource groups prevent overlapping tests of the same native fixture;
there is no cross-platform qualification lock.

## Release path

1. Discover the stable official `openai/codex` release. Never accept commands,
   executable URLs or signing keys from release notes.
2. A dedicated native runner creates a disposable checkout, verifies the official
   archive hash and complete payload, and packages the exact candidate.
3. Run every platform gate: initialize, real Axiom turn, tools/sandbox, streaming,
   resume, cancellation, MCP, UI and controlled provider-adapter tests. Failed,
   missing, skipped or flaky evidence never counts as success.
4. Only success unlocks that platform's protected publisher job. Verify evidence
   hashes, current pipeline source commit, discovered version and native target.
5. Read/verify the current site catalog, merge the qualified platform, preserve
   other platforms' exact receipts, and sign a seven-day Ed25519 catalog. Do not
   replace immutable versions or downgrade from delayed reports. Retain up to
   sixteen versions per platform; installed receipts remain available for rollback.
6. Serialize only this short publication, not QA. Restricted SSH performs atomic
   compare-and-swap replacement and read-back verification. Conflicts fail safely.

Public endpoint: `https://synora-ai.org/updates/core/stable-v1.json` (GET/HEAD only).
The uploader is restricted to catalog read/replacement, with no shell or arbitrary
site writes. The existing pinned signing key/adapter and client trust stay intact.

## Users do not need to leave their computers on

Qualification/publication do not require users' computers or Synora to be open.
Synora 0.2.3 checks thirty seconds after launch, then every six hours. It verifies
the signed platform-specific catalog, downloads/verifies the official payload,
probes a private Core home, and automatically activates only when sessions are
idle. Activation is reported, and the previous runtime/data are retained.

This updates **Core**, not the entire Synora installer. Compatible Core releases
need no app rebuild. UI/adapter changes require a separate qualified Synora app
release; catalog publication must not be reported as rebuilt desktop/Web packages.
An incompatible adapter requires a new adapter ID and app release.

Failed activation, expired/invalid catalogs and unavailable networks never replace
the installed runtime. Installed signed authorizations survive expiry for offline
restart and rollback. OS permissions are never bypassed.

## Operations

Protected, project-only native runners: `synora-gitlab-linux-x64`,
`synora-gitlab-macos-arm64`, `synora-gitlab-windows-x64`. Separate unprivileged
publisher runner/account: `synora-gitlab-publisher`. Mac/Windows need a real
interactive QA desktop; Linux uses Xvfb. Never use production app profiles.
Use a dedicated always-on Mac, not the owner's laptop. Missing native capacity is
pending/failed qualification for that platform only, never an implicit pass.

Native environment: `SYNORA_TEST_ENDPOINT`, `SYNORA_TEST_SEARCH_URL`, and on
Windows `SYNORA_TEST_PREPARED_WINDOWS_QA` (pre-provisioned dedicated sandbox).
Protected environment scope `core-channel-publisher` holds only publisher secrets:
`SYNORA_CHANNEL_SIGNING_KEY`, `SYNORA_CHANNEL_DEPLOY_KEY`,
`SYNORA_CHANNEL_KNOWN_HOSTS`, `SYNORA_CHANNEL_DEPLOY_HOST`,
`SYNORA_CHANNEL_DEPLOY_USER`. Native jobs cannot access these keys.

Private maintainer-only GitLab artifacts retain JSON evidence and failed Playwright
traces for fourteen days. Do not collect Core homes, credentials or profile databases.

## Verification

`tests/core-channel-merge.test.ts` covers isolated publication, retained receipts,
successive platform updates, immutable payloads, absent/duplicate reports, delayed
downgrades and bounded history. Existing tests still enforce every native gate,
signatures, expiry/replay, rollback and atomic compare-and-swap deployment.

```sh
npm run typecheck
npx tsx --test tests/core-channel-merge.test.ts tests/core-channel.test.ts tests/core-qualification.test.ts tests/core-updater.test.ts
python3 tests/core-channel-deploy.test.py
```

These tests do not substitute for a real native qualification of each candidate.
