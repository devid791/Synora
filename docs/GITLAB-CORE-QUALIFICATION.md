# GitLab Core qualification

## Requirement CORE-CI-PLATFORM-ISOLATION

GitLab at `gitlab.synapsecorp.org/davide/synora` owns Core discovery,
qualification and publication. GitHub remains a public source/download mirror.
The protected `codex/core-update-channel` branch holds the imported release source;
the pre-existing unrelated `main` product-contract history is not overwritten.

Three independent pipelines/schedules select `CORE_PLATFORM=linux`, `mac`, or
`win`. Each discovers, qualifies and publishes independently. An unavailable or
failed worker cannot hold another platform's publication. Schedules run every
six hours at minutes 03, 23 and 43. All ordinary Core jobs use the server's Linux
runner, including qualification of Mac/Windows package inventories.
Per-platform resource groups prevent overlapping tests;
there is no cross-platform qualification lock.

## Release path

1. Discover the stable official `openai/codex` release. Never accept commands,
   executable URLs or signing keys from release notes.
2. A Linux server runner creates a disposable checkout and verifies official
   digests, complete payloads and manifests for the Linux candidate and selected
   target. Foreign binaries are not executed or described as native-tested.
3. Run the actual Linux candidate: isolated initialize/settings/history checks,
   actual command/result, streaming, persisted resume and cancellation against a
   deterministic loopback Responses fixture with outside networking disabled.
   Run controlled provider/MCP contracts. This is **compatibility testing**, not
   public model inference, a complete native app audit, or an OS permission grant.
   Failed, missing, skipped or flaky evidence never counts as success.
4. Only success unlocks that platform's protected publisher job. Verify evidence
   hashes, current pipeline source commit, discovered version and selected target.
5. Read/verify the current site catalog, merge the qualified platform, preserve
   other platforms' exact receipts, and sign a seven-day Ed25519 catalog. Do not
   replace immutable versions or downgrade from delayed reports. Retain up to
   sixteen versions per platform; installed receipts remain available for rollback.
6. Serialize only this short publication, not QA. Restricted SSH performs atomic
   compare-and-swap replacement and read-back verification. Conflicts fail safely.

Public endpoint: `https://synora-ai.org/updates/core/stable-v2.json` (GET/HEAD only).
The uploader is restricted to catalog read/replacement, with no shell or arbitrary
site writes. The signing key and protocol adapter are unchanged. The explicit v2
policy is `server-compatibility-local-activation-v1`; its receipt names Linux as
the tested runtime and requires local activation. Legacy v1 is left untouched.

## Users do not need to leave their computers on

Qualification/publication do not require users' computers or Synora to be open.
The updated client checks thirty seconds after launch, then every six hours. It verifies
the signed platform-specific catalog, downloads/verifies the official payload,
probes version, initialize, settings and history APIs in a private Core home,
and automatically activates only when sessions are
idle. Activation is reported, and the previous runtime/data are retained.

**Migration requires one Synora app update**: already installed 0.2.3 clients
understand only v1 native qualification; they cannot acquire the v2 policy from a
catalog. New clients can still read retained v1 receipts for offline recovery.
Do not announce migration complete on a device until its new app is installed.

After this one-time migration, this updates **Core**, not the entire Synora installer. Compatible Core releases
need no app rebuild. UI/adapter changes require a separate qualified Synora app
release; catalog publication must not be reported as rebuilt desktop/Web packages.
An incompatible adapter requires a new adapter ID and app release.

Failed activation, expired/invalid catalogs and unavailable networks never replace
the installed runtime. Installed signed authorizations survive expiry for offline
restart and rollback. OS permissions are never bypassed.

## Operations

Protected, project-only native runners: `synora-gitlab-linux-x64`,
`synora-gitlab-macos-arm64`, `synora-gitlab-windows-x64`. Separate unprivileged
publisher runner/account: `synora-gitlab-publisher`. **Ordinary scheduled Core
updates never require the Mac/Windows runners.** Full native app QA can be selected
separately with `CORE_FULL_APP_QA=1`; it has no automatic Core-publication job and
retains all ten original gates, including live inference and external MCP.
For that full app lane only, Mac/Windows need a real
interactive QA desktop; Linux uses Xvfb. Never use production app profiles.
Missing native capacity blocks that full app audit only, not ordinary Core
qualification or another platform. No inference or OS-grant prompt is sent to
users by the local activation probe. Existing permission choices are preserved.

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

Central receipts deliberately do not claim a real native qualification of each
platform. The mandatory native client probe is a limited compatibility check,
not a substitute for the separately documented full app release tests.
