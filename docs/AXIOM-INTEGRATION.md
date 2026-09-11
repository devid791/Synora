# Axiom and Codex App Server integration

Synora's privileged service owns a real Codex App Server process. App Server
manages thread/turn state, tool dispatch, approvals and the provider request.
Axiom supplies inference through a native Responses-compatible route. This is
not a replacement App Server, a tool-permission bypass or a second model proxy.

For compatible Axiom builds, configure provider base URL
`http://127.0.0.1:8015/codex/v1` when the server really runs on the same host.
Use the operator's actual secure endpoint for a remote server, and enter a
required Bearer token only in the credential field.

| Surface | Purpose |
| --- | --- |
| `/codex/v1/models` | Model and Codex capability discovery |
| `/codex/v1/responses` | Codex-specific tool/schema translation and response streaming |
| `/v1/responses` | Separate strict native Responses contract |
| App Server stdio JSON-RPC | Synora's thread/turn/tool/approval boundary, not an HTTP provider route |

The Codex route preserves original call IDs, tool names/namespaces, custom input
and result history while applying request-local native schema translation.
Unsupported definitions must remain explicit. A visible catalog entry is not a
grant to execute it; original Core and the actual plugin/MCP connection still own
execution and permissions.

See the [Axiom Kernel repository](https://github.com/devid791/axiom-kernel) for
its buildable integration and public release boundary. The native Axiom HTTP
daemon does not itself supply internet-facing authentication/TLS. Do not expose
an unauthenticated inference/operations service to the internet.

A complete check follows an actual Synora action through Core, the model, tool
execution, the returned result and saved/cold-recovered state. A successful
health check or an initial SSE event is not an end-to-end inference pass.

Upstream protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
The generated protocol baseline is 0.153.4; explicitly qualified runtime updates
are represented separately in source. No account grant is included in this repo.
