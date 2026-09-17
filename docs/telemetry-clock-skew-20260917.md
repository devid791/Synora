# Telemetry clock-skew correction — 2026-09-17

## Incident and reproduction

The office Windows PC `192.168.25.55` identified itself as
`NUCBOX_K10.systemipm.local` in a read-only RDP NTLM negotiation through the
MacBook SSH tunnel. Its clock was about **30 seconds ahead** in two measurements:

- Local UTC `13:14:53`, remote reported UTC `13:15:23`.
- Local UTC `13:24:23`, remote reported UTC `13:24:54`.

No credentials were tried, no desktop session was opened, and the office PC's
clock, domain policy and installed application were not changed.

The published app compared remote `sampledAt` directly against client `Date.now()`
with a seven-second freshness threshold. The runtime status used local receipt
time instead. This accounts for simultaneous "Axiom generating" and stale GPU
readouts despite successfully delivered samples.

The installed 0.2.1 app on Axiom Builder reproduced the failure in four of four
fresh public-HTTPS observations when only its main/renderer process clocks were
advanced 30 seconds. The Windows system clock was not changed.

## Correction

- Preserve original hardware/node sample timestamps and sensor values.
- Use the same-origin HTTP Date as the remote clock reference, conservatively
  including its one-second precision, cache Age and full request duration.
- Advance previously observed remote time with a monotonic clock so refetching
  a frozen response cannot keep its sample alive indefinitely.
- Keep strict fallback when HTTP timing is missing or invalid. The serving
  proxy and hardware producer must share a clock domain; this does not infer
  independent worker clocks or invent per-node synchronization.
- Apply the reference consistently to compact GPU status, details, memory
  panels and the compatibility GPU projection. Retain stale/future checks.
- Use monotonic time for request duration and the two-second status cache;
  request status with `cache: no-store`.

## Verification and limits

- Linux: **731/731** automated tests passed; TypeScript and diff whitespace
  checks passed. Regression coverage includes ±30 seconds and ±12 hours,
  stale/future nodes and roots, cached Age, frozen replies, missing/invalid
  timing, background expiry and local clock rollback.
- Axiom Builder native interactive app, newly built Windows source candidate:
  **18/18 live UI observations** remained readable under ±30 seconds skew.
  Actual public-provider Core inference completed, producing a 1,973-character
  assistant message; measured GPU reached 99%. Minimize/restore also passed.
  Only process clocks were substituted, not sensor responses or inference.
- The old installer was used for the four-sample failure reproduction. The
  corrected candidate was run from its Windows production build under Electron;
  this is not a certification of a newly packaged installer.
- Additional full Windows unit run: 729 passed; two tests could not create
  their TLS fixtures because `openssl` is absent from the Builder test PATH
  (`spawnSync openssl ENOENT`). Neither is counted as passing on Windows.
- An initial UI harness attempt ended with a closed window before observations;
  it is excluded. The successful run applied the process clock shift after
  opening telemetry rather than during application startup/reload.
- No new release has been published and the office PC is not upgraded yet.

Private evidence: `out/hardware-release/publication/windows-clock-qa.json`,
before/after screenshots, `clock-fix-unit-tests.log`,
`windows-clock-unit-tests.log`. QA credentials were removed after the run.
