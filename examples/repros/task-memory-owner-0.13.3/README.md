# Disjoint child Memory progress — official 0.13.3

The package uses two independent Memory regions and constant keys. Its owner writes one record, starts a child that writes the other, then waits for console input. Bind an existing writable directory at `/probe-state`, run `etas run . --allow-effects`, and leave input pending after `WAIT_INPUT`.

Observed: `CHILD_RAN` appears only after input is submitted. Native trace records `unresolved_resource_selector` serialization on scope 0; the child write is dispatched after the console read finishes. Both records eventually persist correctly and the flow exits 0. The failure concerns child progress during input wait, rather than storage correctness or final exit status.

The public report is [etas-interpreter#108](https://github.com/etas-project/etas-interpreter/issues/108); `UPSTREAM_ISSUE.md` is its exact body. The native capture candidate and minimal evidence are recorded in `examples/native-project/task-memory-owner-0133-20261112.json`. No resource guards or compiler sources are changed.
