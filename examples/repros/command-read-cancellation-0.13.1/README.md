# Pending native command-read cancellation — official 0.13.1

The checked-in package is the exact executed positive cancellation case. It consumes a synthetic producer's `ready` output, then races a blocked native read against one console line. Bind an existing writable temporary directory at the configured `/probe-state` region, run the package and submit a line after `WAIT_INPUT`.

The console branch completes and the runtime requests cancellation, but the pending native read does not finish until the synthetic producer is externally terminated. The captured 138.9-second read and final exit 0 after explicit test cleanup are a failed cancellation acceptance, not a passing fallback. The public report is `UPSTREAM_ISSUE.md`.

No compiler/Host patch or production workaround is installed. This fixture is independent of the source backslash-escape issue.

Published report: [etas-core#65](https://github.com/etas-project/etas-core/issues/65).

## Official 0.13.3 acceptance

The original package source is unchanged. The losing read now settles with `Cancelled` in 911 microseconds, and the flow exits 0 about 35 milliseconds after input. No explicit producer termination or `Command.stop` is used. Compiler/source identities and native trace observations are in `examples/native-project/command-read-cancellation-0133-20261112.json`. The historical failed run above remains intact. Production continuous capture is separate Nomo work.
