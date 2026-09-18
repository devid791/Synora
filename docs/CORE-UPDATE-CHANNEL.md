# Automatic Core update channel — historical initial rollout

**Superseded operational procedure:** see [GitLab Core qualification](GITLAB-CORE-QUALIFICATION.md).
The GitHub scheduler and all-platform signing barrier described below have been
retired. This document retains the initial rollout history, not current setup instructions.

## Implementation and rollout status

This change implements a separately signed Core compatibility catalog and the
automation to produce it. It does **not** make the already published Synora
0.2.2 installers dynamic: users need one new Synora build containing this client
and its public trust key. Subsequent compatible Core releases do not require
rebuilding Synora. An incompatible adapter/protocol still requires an app update.

The public signed bootstrap, protected publishing environment and three native
workers have been provisioned. A bootstrap authorizes zero new binaries; only
a successful complete native workflow may authorize a candidate. Unit tests
and initialize probes do not substitute for that first end-to-end run.

## Release path

1. Every six hours the workflow discovers the newest **stable** `openai/codex`
   release. A queue guard cancels a run if no native worker picks up pending
   work for ten minutes. It needs only the run's Actions token, not a permanent
   repository administration credential.
   No commands, executable URLs or trust keys are read from release notes.
2. Dedicated Linux x64, macOS arm64 and Windows x64 workers create disposable
   source worktrees, verify the official archive digest, inventory all regular
   payload files and build a candidate app with those exact pins. Production
   installations are never used as qualification workspaces or replaced.
3. Native initialization, real Axiom tool/stream/resume/cancel tests, native web
   tooling and UI checks run against the candidate. The provider-adapter unit
   matrix is explicitly **controlled**, not third-party public model inference.
   Expected runtime selection and packaged archive hashes are asserted.
4. Any failure, skipped/flaky/empty suite, missing native prerequisites or missing
   platform blocks signing. Workers receive no signing or deployment key.
5. A protected publishing job verifies the reports and evidence hashes for the
   same version/source across all three platforms. It signs a seven-day catalog
   with Ed25519 and atomically replaces the single read-only public JSON file.
6. Running Synora checks after 30 seconds and every six hours. It admits only
   signed, fresh, platform/adapter-matching updates, then downloads from the
   fixed official repository, verifies the complete payload and probes startup
   in a fresh private Core home. It waits for idle sessions before switching.

The client retains the previous runtime and data for explicit rollback. A failed
automatic candidate is suppressed across restart; a rollback also suppresses
automatic reinstallation of that same version. It does not terminate active
turns, alter OS permissions, grant tools access or execute inference to probe a
user's installation.

## Trust and failure behavior

- Public endpoint: `https://synora-ai.org/updates/core/stable-v1.json`.
- Only the pinned Ed25519 key in `src/engine/core-channel.ts` can authorize a
  release. HTTPS hosting access alone cannot authorize executable code.
- Metadata is bounded; payload paths, complete file hashes, duplicate versions,
  platform, protocol, adapter identity, required gates and validity are checked.
- Monotonic catalog sequences reject replay and conflicting same-sequence
  catalogs. Version payloads and retained authorizations cannot be replaced.
- Signed installed authorizations survive catalog expiry/network loss, so an
  offline restart or rollback still works. Expiry/withdrawal blocks a **new**
  activation, including expiry during a download/probe.
- Missing/unavailable/invalid catalog leaves the selected Core untouched and
  displays a channel error. It never falls back to trusting `/releases/latest`.
- Corrupt saved channel metadata does not silently reset replay protection.
- Adapter ID `synora-core-adapter-20260917-v1` must change if supported adapter
  semantics change incompatibly. Key rotation requires a trusted app update.

## Operations and one-time provisioning

1. Install dedicated, interactive self-hosted QA runners labelled
   `synora-qa-linux-x64`, `synora-qa-macos-arm64`, and
   `synora-qa-windows-x64`. They need the project's pinned build dependencies,
   native compiler/toolchains and desktop. Linux uses a separate unprivileged
   OS account; Mac/Windows use dedicated QA checkout and application profiles in
   their authorized interactive desktop session. Never use personal Synora/Core
   state or grant execution to PR workflows. These jobs run only from main.
   Closing the desktop, sleeping the Mac, or losing the VPN makes qualification
   unavailable: readiness fails explicitly and the next cycle retries. No forced
   login, disabled sandbox, or automatic OS permission bypass is installed.
2. Configure the workers' `SYNORA_TEST_ENDPOINT` and `SYNORA_TEST_SEARCH_URL`
   using dedicated QA services/credentials. Windows additionally needs its
   own pre-provisioned `SYNORA_TEST_PREPARED_WINDOWS_QA` sandbox. The workflow
   does not click UAC prompts or weaken permissions if the prerequisite fails.
3. Configure protected environment `core-channel-publisher` with secrets
   `CORE_CHANNEL_SIGNING_KEY`, `CORE_CHANNEL_DEPLOY_KEY`, and
   `CORE_CHANNEL_KNOWN_HOSTS`. Configure repository variables
   `CORE_CHANNEL_DEPLOY_HOST` and `CORE_CHANNEL_DEPLOY_USER`. The environment
   admits only the main branch. A separate deploy key is restricted by the
   root-owned `scripts/core-channel-deploy.py` forced SSH command: only catalog
   read and bounded compare-and-swap publication, no shell, forwarding, SFTP or
   caller-supplied paths. The publisher cannot access the rest of the site.
4. The signing private key must match the compiled public key. Store it outside
   the repository, installers, public site and test artifacts. It is separate
   from macOS app-signing and Git SSH keys.
5. Provision the initial **signed empty** catalog in that directory once. There
   is no automatic “missing catalog means reset” path. Serve it as JSON with
   short/no caching; allow public GET/HEAD only, no public upload endpoint.
   `scripts/bootstrap-core-channel.ts NEW_OUTPUT`, run through `tsx` with
   `SYNORA_CHANNEL_SIGNING_KEY_FILE` set to the protected private key, creates
   this empty catalog with exclusive-create semantics. It authorizes no binary.
6. Enable repository variable `CORE_CHANNEL_ENABLED=true` and run the workflow
   from the protected release/default branch. Do not promote until all native
   jobs pass against the candidate. A failed older UI test must be investigated,
   not removed from the gates or represented as a successful qualification.
7. Build/test/release the updated Synora app once. The currently published
   0.2.2 packages and installed Macs remain unchanged by this source change.

No ongoing manual allowlist editing or approval click is required after this
setup for releases that pass the automatic gates. Genuine incompatibility is
reported and withheld rather than installed optimistically.

The public endpoint has no-store caching and GET/HEAD only. The private deploy
transport is unrelated to public HTTP and cannot be used as a public upload
endpoint. Workers have neither signing nor site deployment credentials; their
backend SSH identity permits only local forwarding to the Axiom API, not shell
commands or host administration. Native jobs are serialized against the shared
inference backend. Evidence is retained for 14 days, and each run removes only
its own detached temporary source worktree after artifact collection.

## Developer checks

```sh
npm run typecheck
npx tsx --test tests/core-channel.test.ts tests/core-qualification.test.ts tests/core-updater.test.ts tests/qualified-core.test.ts
npm test
```

Fixtures sign with ephemeral test keys, never the production signing key.
Tests cover new signed releases, automatic idle admission, expiry during probe,
offline restart, signatures, replay, payload replacement, platform mismatch,
missing/skipped/controlled-only gates, bounded responses and existing rollback.
