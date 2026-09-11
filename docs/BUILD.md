# Build and run Synora

The public source builds the same application runtime as the Mac reference.
Its packaging configuration intentionally does not contain the maintainer's
private signing identity. Building it does not modify an installed Synora app.

## Prerequisites

Use Node.js 22.19 or a compatible newer release, npm and the native compiler
tools required by node-pty/Electron on your host. Linux native web tools need a
C++17 compiler, pkg-config and libcurl development files; macOS uses its C++
toolchain and libcurl. Windows native web tools use CMake, MSVC and the pinned
curl/zlib source downloads. Review install scripts before installing dependencies.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The default tests are host-side tests, including controlled transports. They do
not establish a full live provider or native-platform qualification. Historical
platform fixtures include sanitized example paths and are not ready-made
deployment scripts for your machine.

## Prepare real runtime resources

The full official Core package is pinned by size/hash and by its extracted file
manifest. Do not replace it with a single executable or edit its contents.

```sh
node scripts/download-core.mjs
node scripts/build-web-mcp.mjs
npm start
```

The first command downloads the current host's pinned Core archive into
`out/core-packages/`. It does not install a system-wide Codex or use another
app's account. The second builds the application-owned native web helper.
On Windows, run `node scripts/download-curl.mjs` before building the helper.
Choose and configure an actual provider in Models & accounts after launch.

## Local web interface

```sh
npm run build:web
npm run start:web
```

The default service is `http://127.0.0.1:4319`. An explicit `SYNORA_WEB_PORT`
can choose another local port. The host/origin/session boundary is part of the
security design. Do not make it internet-facing or treat it as the static
synora-ai.org website: its host can read/write files and execute terminal work.

## Packaging

Build on the intended operating system with its actual native dependencies.
Prepare the matching Core and web helper first, then use `npm run package:linux`,
`npm run package:win` or `npm run package:mac`.

The pinned bootstrap Core architectures are Linux x64, Windows x64 and macOS
ARM64. Cross-compiling an installer is not a claim that it runs correctly on
the target host. Run real packaged tests separately before distributing a build.

Public Mac builds use ad-hoc signing by default, not the maintainer's persistent
local signing identity or Apple notarization. Set up your own appropriate
distribution signing separately; never copy another person's signing material.
Do not overwrite the official app with a development build and expect credential
trust to remain identical.

## Documentation

`docs/manual.md` is the English user manual, also rendered as the website's
searchable manual. Changes to either presentation must keep the wording aligned.
Runtime source and protocol fixtures must remain consistent with their pinned
metadata; do not label an untested Core update as qualified.
