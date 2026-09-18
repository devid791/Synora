# Synora 0.2.5 — existing Core home update recovery

Candidate. Do not infer publication or installation from this source checkpoint.

The first native 0.2.4 Mac check on the user's existing profile exposed a real
activation failure: Core creates executable alias symlinks inside
`<provider-home>/tmp/arg0/`. The strict recovery copier correctly refused links,
but incorrectly treated this regenerated temporary directory as persistent data.
The previous runtime remained selected; the previous app bundle was retained.

The fix omits only a real directory at that exact per-home temporary boundary.
It never follows its links, never deletes the original home, and continues to
reject symlinks at the boundary and everywhere else. Neighboring files, history,
configuration and credentials remain covered by integrity-checked recovery.

Automatic activation failures are now scoped to an updater algorithm revision:
the corrected updater may retry a legacy failed candidate once, then suppress
further attempts on failure, including after restart. Explicit rollback remains
respected, including legacy rollback state. No approval or OS permission bypass
is introduced; updates still wait for idle sessions.

Regression tests cover both account/provider homes, retained neighboring data,
rollback, refusal of symlinked boundaries, legacy failure retry and legacy
rollback suppression. Final native/package results are recorded separately.
