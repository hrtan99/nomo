# Computed Memory log keys — official 0.13.4

The original constant-selector #108 case now passes on 0.13.4. This separate positive consumer case appends two computed keys in an independent child Memory region while the owner waits for input. Bind an existing writable directory at `/probe-state`, run `etas run . --allow-effects`, and leave input pending after `WAIT_INPUT`.

Observed: the child still runs only after input is submitted. The trace records one `unresolved_resource_selector` serialization event; both child records persist correctly and the flow exits 0. This may be the intended conservative fallback for computed selectors. The remaining requirement is a supported ownership contract that allows a durable collector and its interactive UI to progress safely.

The exact public follow-up is `UPSTREAM_FOLLOWUP.md`, published on [#108](https://github.com/etas-project/etas-interpreter/issues/108#issuecomment-6815750299). Compiler, source, trace and actual product-candidate evidence are recorded in `examples/native-project/task-memory-log-0134-20261112.json`. No guards or compiler sources are changed.

## Official 0.13.5 acceptance

The same source, manifest and lock now print `CHILD_RAN` before console input is submitted. Both child writes complete during that wait, with no scope-serialization events. Exact compiler/source/trace identities are in `examples/native-project/task-memory-log-0135-20261112.json`. This accepts the reduced computed-key case; the actual Nomo collector remains a separate product scope.
