# Native web executor provenance

Originally reused from the owner's Axiom source checkpoint
`8a7c47750b0e962f40ae1f6285d5277a8ac283aa`, not from installed production files.

- `axiom_codex_web_mcp.cpp`: SHA256 `9ec6fcaa61bcb01f692dc1eed1afd602f3441d20cf21252797cdd32ee8a5d5bb`.
- `axiom_aliced_json.h`: SHA256 `3887362b9cd76498ee99c14acb5072d588940f6334433bd6252eb58fcef37cfd`.

Synora-only portability changes on 2026-09-09: owned environment strings
(`_dupenv_s` on Windows, preserving absent vs empty values), and protection
against the Windows `min` macro. Tool schemas, networking/error semantics and
budgets are unchanged. Original kernel files were not modified. Current
source/binary hashes are recorded by each native build's manifest.

The CPU-only qualification was reused as `tests/web-mcp-safety.mjs`, changing
only the relative source location and portable temporary-directory location.
It is separate from real App Server/model qualification. Both web results and
provider warnings remain untrusted data. GET-only is not an egress sandbox.

Build with `node scripts/build-web-mcp.mjs`. Requires a C++17 compiler and
libcurl >=7.85 with asynchronous DNS. The native binary and its receipt live
in the generated per-platform output, not in this source directory.
Cross-platform package qualification must use the respective native binary;
a successful Linux build does not qualify Windows/macOS distribution.
