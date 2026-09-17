# Synora Web

The browser app uses the same interface and application services as Synora
Desktop. It is not the presentation website or its demo.

## Start

Install Node.js 22.19 or newer, extract the package matching your **server's**
operating system and architecture, then run `node start.mjs` inside that folder.
Alternatively run `start-synora-web.sh` (macOS/Linux) or `start-synora-web.cmd`
(Windows). Open the exact local URL printed in the terminal, normally
`http://127.0.0.1:4319`. Keep the terminal running; Ctrl+C stops the service.

The package contains the compiled UI/server, native terminal module, sandboxed
browser, verified Core archives and native web executor. No project checkout,
compiler or npm installation is required. Linux still needs the normal shared
libraries used by Chromium and libcurl. Do not disable Chromium sandboxing.

## First use

Add a workspace using an absolute path on the service computer. Configure a
provider in **Models & accounts**, select it in **Settings**, read its model
catalog and enable live mode. Inference credentials are not bundled. On Windows,
complete the native sandbox setup if requested. The browser does not grant
operating-system permissions automatically.

Conversations and settings are stored separately under
`~/.local/share/synora-web/`, not in the package. `SYNORA_WEB_DATA_DIR` can select
another private data directory; `SYNORA_WEB_PORT` changes the local port. Keep
this directory when upgrading. Stop the old server, replace the extracted
program folder and restart. Desktop and web profiles are separate by default.

## Security and differences from desktop

The service can operate on local files and run tools. It intentionally binds
only to loopback and enforces Host, Origin, session and CSRF checks. **Do not
publish it through a public proxy, tunnel or static website.** This package is
for running on your own computer, not a multi-user hosted service.

Web browser tabs are isolated and rendered through a remote-frame stream, with
live mouse/keyboard input. Native OS file dialogs are unavailable: use absolute
service paths. Desktop capture/control depends on the native host; a web page
does not inherit the desktop application's OS grants.

## Build and verify

From the release source, run `npm ci`, `node scripts/download-core.mjs`,
`node scripts/build-web-mcp.mjs`, then `npm run package:web`. Build natively on
the target OS. Output is under `out/web-packages/`, with a per-file release
manifest and archive SHA256. Build tooling downloads the pinned browser; normal
startup does not download it. Run both `npm run test:web` and
`npm run test:quality:web`, then qualify the extracted package and live provider
separately before distributing it. Simulated tests are not live inference proof.
