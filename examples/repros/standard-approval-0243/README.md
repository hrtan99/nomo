# Standard approval cannot reach the configured native prompt

On the pinned official Etas 0.24.3 graph, this one-source program passes `check --all` with no diagnostics. Its actual run prints `BEFORE_APPROVAL`, exits 3 with `Analysis(UnhandledEffectAction)` for `std.effects.Approval.request`, and never displays an approval prompt. The trace records the failure; no model, filesystem, command, memory or credentials are involved.

```sh
etas --no-config --cache off check --all --format json .
etas --no-config --cache off run . --allow-effects --trace-out trace.json
```

The manifest enables `approval=allow` and approval mode `prompt`. The source imports the published `std.runtime.approval.approve`; it supplies no application handler. `result.json` records the original executed invocation. The complete raw trace/terminal/check evidence remains at the local path recorded there.

This is a native SDK/Host integration report, not a claim that every host must implement the whole standard library. A source-defined boolean effect named `Approval` is a different contract and is not a replacement for canonical standard approval authority. The source-handler diagnostic experiment passed separately and does not reproduce this native dispatch failure.

Reported upstream: https://github.com/etas-project/etas-interpreter/issues/122.
