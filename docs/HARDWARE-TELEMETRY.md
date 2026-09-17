# Automatic Axiom hardware telemetry

Synora 0.2.1 queries `GET /ops/hardware` at the selected Axiom provider's origin,
with the same credential used by the other status endpoints. Clients do not
need a separate collector address, certificate or token. Redirects are not
followed; each request is bounded to 5 seconds and 512 KiB. Inference does not
depend on telemetry. An older server returning 404/405/501 may use an existing
trusted legacy collector; authentication, TLS and malformed-report failures
are never hidden by that fallback.

The `axiom_hardware_v1` document represents nodes, devices, physical memory
pools, device links and runtime model assignment separately. A GPU inventory
does not prove that the model runs on every listed GPU. Per-device sensor use
includes other processes; assignment describes the loaded model, not ownership
of all utilization by the selected conversation.

Dedicated VRAM and system RAM are distinct pools. Physically unified RAM shared
by CPU and GPU is one pool and is displayed once per node. CUDA unified virtual
addressing or coherent host access alone never implies shared physical RAM.
GPU-addressable capacity can differ from the physical pool's usable capacity.
Unknown readings stay unknown; offline and stale readings are not live zeros.

The current Qwen executor reports its own CUDA-visible devices and the target
device actually held by its loaded model. It is a single-node executor, not a
distributed coordinator. Synora validates and renders multi-node reports, but
that schema/fixture coverage is not evidence of a live cluster. A future
coordinator must report authoritative membership and assignment; neither Synora
nor the executor scans the LAN or invents remote workers. NVIDIA/CUDA discovery
does not claim that absent AMD/Intel/Apple runtime collectors were tested.

## Qualification

- Automated tests cover single and multiple dedicated GPUs, unified shared
  pools, multi-node reports, unavailable workers, clock skew, stale readings,
  malformed identities/accounting and authenticated endpoint discovery.
- Live RTX 5090 probe on VM209 matches NVML identity and memory. No model is
  loaded by the standalone hardware probe.
- Multi-GPU/cluster/unified fixtures are explicitly simulated, not live
  hardware qualification. GX10 and other physical topologies require a real
  reachable executor before they can be marked live-tested.
- Platform package and installation results belong in the release receipts;
  this document does not itself grant a production GO.
