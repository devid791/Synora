# GPU telemetry on Windows, macOS and Linux

The status bar shows the discovered GPU name, measured load and VRAM. On narrow
windows, less important fields collapse into **Details**; the card name and load
remain visible. Multiple cards are listed individually in Details. No card is
hard-coded as GPU 0, and loads are not averaged or guessed from model activity.

There are three independent sources:

- **Conversation activity** comes from Core's actual turn events. Working and
  awaiting approval do not depend on a sensor poll.
- **Axiom server** identifies the configured inference endpoint. GPU readings
  come from a collector explicitly bound to that provider, not from the graphics
  card drawing Synora on a Windows laptop. They are host-wide measurements, not
  proof of per-conversation GPU assignment. Details include device identity, PCI
  address, sensor source and sampling time.
- **Client application** identifies Windows, macOS, Linux or the web service.
  App memory and terminal counts describe that client/service, not Axiom's GPU.

The last completed request's resource snapshot is historical. It is never used
as an instantaneous utilization measurement. A 0% reading is shown only when the
sensor really reports zero; a running conversation can coexist with that sample.

## Missing or old telemetry

**GPU telemetry setup required** means this client has no collector binding for
the selected provider. A setup performed on a Mac is not automatically present
on another Windows installation. This condition does not block inference or mark
App Server offline.

**GPU telemetry unavailable** means the collector cannot be reached, its TLS or
authentication checks fail, or its sensors fail. **GPU sample stale** means the
sample is too old or has an invalid future time. Neither means the card is idle.
An empty inventory with failed sensors is not reported as “No GPU detected”.

## Operator provisioning

The existing private connection registry is `gpu-collectors.json`, alongside the
running installation's `state.sqlite` in Electron's `userData` directory (or the
explicit `SYNORA_DATA_DIR`). Determine that installation's actual data directory;
do not copy another installation's conversation database or provider credentials.

Each registry entry has exactly these fields:

- `providerEndpoint`: the selected Axiom `/codex/v1` URL, matched exactly except
  for its final slash;
- `endpoint`: the trusted collector's HTTPS URL ending in `/v1/gpus`, without
  embedded credentials, query or fragment;
- `certificate`: its trusted PEM certificate/CA;
- `token`: its dedicated 64-character hexadecimal telemetry token.

The file contains an array with at most 32 entries and one entry per provider.
Provision it only through a trusted operator channel. Preserve unrelated entries,
restrict it to the owning user (POSIX mode 0600; Windows user-specific ACL), and
never include it in downloads, source control, screenshots or diagnostic logs.
Use the collector's own token, not a model-provider token. Do not disable TLS
verification, publish a private collector, or silently substitute the client GPU
when the intended server is unavailable. Readback to the renderer contains only
validated measurements or a sanitized error, not connection secrets.

This source update improves reporting and failure handling. It does **not**
provision a remote Windows installation or move/enable any production collector.
See [release scope and limitations](RELEASE.md). A source build or a green
connection indicator does not establish end-to-end platform qualification.
