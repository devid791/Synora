# Production application publication — internal GitLab

The canonical pipeline is on `gitlab.synapsecorp.org/davide/synora`, protected
branch `codex/core-update-channel`. GitHub is an optional mirror, not the download
origin or release gate. This is separate from the signed Core update channel.

For an application change, update the version in `package.json` and its lockfile,
and include `releases/<version>.md`. Push to the protected branch. Source, public
assets, native code, dependency or release-note changes automatically select the
application pipeline. Each platform independently builds, tests the compiled app,
checks its package, uploads it into the internal registry, then publishes through
a restricted SSH receiver. The website reads `downloads/releases/latest.json` and
shows each platform's own version, description, direct download and checksums.

Mac builds require a dedicated ARM64 macOS runner with the existing signing
identity, `SYNORA_MAC_SIGN_SCRIPT` and `SYNORA_MAC_SIGN_REQUIREMENT`. Windows uses
the interactive builder runner; Linux and Web use the server worker. An offline
or failing native worker stops ONLY its own release. It cannot be replaced by a
Linux check masquerading as native QA. Publishing an already qualified package
does not require the original test computer to be online.

The independent `APP_RELEASE=1` recovery lane reads `releases/app-stable.json` and
verifies already qualified registry archives and their pinned reports. It is used
for the initial 0.2.5 migration, not to rebuild or silently replace these packages.
Normal builds supply their generated entry artifact and run the same publisher.

Use the internal registry's HTTPS origin with the checked-in public CA for large
package transfers; never disable TLS verification or send uploads through the
public CDN's size/time limits. CI job tokens are sent on stdin, not command lines.
Deployment credentials are protected and scoped to `app-release-publisher`.
The SSH key permits only bounded upload, manifest publication and readback; no
shell, forwarding or public HTTP upload. The receiver verifies bytes again,
keeps versioned archives immutable, rejects downgrades and merges platform entries
under a lock. Public requests remain GET/HEAD only. Retry publication of identical
bytes is safe. The site retains working static links if the manifest cannot load.

Checks: `node --test tests/app-release.test.mjs` and
`python3 tests/app-release-deploy.test.py`. A successful publication job records
the direct public URL, byte count, SHA-256 and pipeline ID in its artifact.
Qualification scope and known issues remain in release notes; release branding
does not assert that every external account or OS permission was tested.

## Verified publication on 2026-09-18

Pipeline 17002 successfully published all four 0.2.5 platforms through GitLab:
jobs 32023 (Linux), 32024 (Web), 32025 (Windows), 32026 (Mac). All four complete
downloads were read back from the public website and matched their expected
byte counts and SHA-256 values. Browser checks verified the versioned direct
links and mobile layout. Public POST is 405; private deployment files are 404.

The full future native build chain has been linted, not yet exercised as a new
release. Linux and Windows runners are online. The registered Mac runner has
never connected; the Mac Mini at the known address was unreachable. A dedicated
Mac worker with the existing signing identity is still required for future Mac
builds. This does not affect publication of the already qualified 0.2.5 Mac ZIP
or block other platforms. Do not describe future Mac build automation as tested.
