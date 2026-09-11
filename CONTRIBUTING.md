# Contributing to Synora

Start with the user manual and build guide. Use a small isolated workspace for
tests; never run unfamiliar code against your normal conversations or credentials.

For a bug, include the app and App Server versions, operating system and
architecture, provider/model, reproduction steps, expected result and actual
result. Distinguish a completed real inference from a simulated/controlled
test, a connection check or a missing prerequisite.

For a change, keep it focused and add a regression test. Run the applicable
type, unit and build checks. Explain any tests that need accounts, a GPU or a
particular native platform. Do not turn a blocked test into a pass or remove a
feature simply to get a green result.

Keep renderer, privileged services, provider transport and remote browser
content separate. Never add a generic unrestricted IPC/command interface.
Treat prompts, imported presets, remote pages and tool output as untrusted data.

Do not commit secrets, user storage, private network settings, weights,
downloaded runtimes, signing keys or generated installers. New contributions
to Synora-owned files use the project's MIT license; preserve existing
third-party licensing and provenance.
