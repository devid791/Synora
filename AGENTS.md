# Synora production release workflow

Synora is a production application, not a preview. Keep factual installation
requirements and known issues explicit; do not relabel a failed test as passed.

Every application change must include an incremented stable package version in
`package.json` and `package-lock.json`, and `releases/<version>.md`. Publish through
the internal GitLab pipeline documented in `docs/APP-RELEASE-WORKFLOW.md`.
Do not finish a release by updating GitHub alone or by merely changing website
labels. Verify the platform's GitLab publication job and its real direct file on
`https://synora-ai.org/downloads/releases/`, including its SHA-256 and version.
Never replace the bytes of an already published version. Platforms advance
independently; retain a working download while another platform is blocked.
Native platform tests require real native workers. Publishing already qualified
packages must not depend on the user's personal desktop being online or unlocked.
