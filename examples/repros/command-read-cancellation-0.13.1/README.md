# Pending native command-read cancellation — official 0.13.1

The checked-in package is the exact executed positive cancellation case. It consumes a synthetic producer's `ready` output, then races a blocked native read against one console line. Bind an existing writable temporary directory at the configured `/probe-state` region, run the package and submit a line after `WAIT_INPUT`.

The console branch completes and the runtime requests cancellation, but the pending native read does not finish until the synthetic producer is externally terminated. The captured 138.9-second read and final exit 0 after explicit test cleanup are a failed cancellation acceptance, not a passing fallback. The public report is `UPSTREAM_ISSUE.md`.

No compiler/Host patch or production workaround is installed. This fixture is independent of the source backslash-escape issue.

Published report: [etas-core#65](https://github.com/etas-project/etas-core/issues/65).
