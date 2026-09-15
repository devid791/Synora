# Synora

A focused AI workspace for conversations, files, models, agents and tools.

Synora connects its desktop or local web interface to a Synora-owned Codex App
Server. It includes model/provider selection, file and terminal tools, image
input, visible provider-reported reasoning, agent split views, tutor supervision,
bot presets, plugins/MCP, permissions, conversation management and backend
telemetry. Configured is not the same as connected: real tools and providers
require their actual prerequisites and account grants.

- [User manual](docs/manual.md) — installation, first use, every major view,
  permissions, troubleshooting and known limitations.
- [Build and run](docs/BUILD.md) — desktop and local web development.
- [Axiom integration](docs/AXIOM-INTEGRATION.md) — the `/codex/v1` boundary.
- [Browser and computer control](docs/COMPUTER-USE.md) — new source implementation,
  consent, supported actions and pending platform qualification; not yet in downloads.
- [GPU telemetry](docs/GPU-TELEMETRY.md) — server/device provenance and trusted collector setup.
- [Release scope](docs/RELEASE.md) — provenance, signing and qualification limits.
- [Synora website](https://synora-ai.org/) — presentation and download destination.
- [Axiom Kernel](https://github.com/devid791/axiom-kernel).

## Download the app

The [desktop preview release](https://github.com/devid791/Synora/releases/tag/v0.1.0-foundation.2)
provides the original macOS Apple-silicon ZIP, Windows x64 EXE and Linux AMD64 DEB,
with `SHA256SUMS.txt` and `RELEASE-NOTES.txt`. Choose the installer assets, not
GitHub's automatically generated source archives. The same files are available
on the [website](https://synora-ai.org/#downloads).

These are preview packages: macOS is not Apple-notarized, Windows is unsigned,
and the existing cross-platform qualification limits remain. The release job
verifies the original hashes before upload and GitHub's hashes before publishing;
it does not rebuild the apps or change their QA status.

## Development quick start

Use Node.js 22.19 or a compatible newer version and npm. Native runtime and
packaging prerequisites are described in the build guide.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The user interface is not a model server. Downloading or building Synora does
not provide model weights, paid API access or a remote Axiom deployment. For
real tools, prepare the pinned Core package and native web helper as described
in the build guide. A simulator is available for explicitly labelled regression
work; it is not real inference.

## Status

The source now contains the `0.2.0` release candidate, including browser/computer
control, composer history, same-turn guidance and clearer GPU reporting. It does
not import private Git history or operational data. The downloadable packages
still use baseline `67eed3d`; source changes are not a published binary update.

There is no blanket production GO for every provider and platform. In particular,
the aligned Linux/Windows packages have an open small-window/150%-zoom layout
issue and an account-check busy-feedback issue. Account-dependent tests,
hardware/large-context claims and upstream experimental APIs require their own
qualification. See the manual and release scope rather than inferring readiness
from a passing build.

## Contributing

Ideas, bug reports, documentation improvements and code contributions are
welcome. Open an issue with the app/OS/Core versions, minimal steps, expected
behavior and sanitized results. Do not upload credentials, personal chats,
application storage or private files. Read [CONTRIBUTING.md](CONTRIBUTING.md).

Synora-owned code and documentation are licensed under MIT. This does not
relicense dependencies, generated upstream protocol definitions or upstream
runtime packages; see [NOTICE](NOTICE).

Created by [Davide Zenati](https://x.com/ZenatiDavide).
Thanks to OpenAI for making [Codex App Server](https://learn.chatgpt.com/docs/app-server)
available. Synora is independent and is not an OpenAI product or endorsement.
