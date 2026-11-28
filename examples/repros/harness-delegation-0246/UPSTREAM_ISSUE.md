Published: https://github.com/etas-project/etas-interpreter/issues/124

## Source check passes, production entry preparation rejects a declared field

On the unmodified official CLI 0.24.6 graph, a 94-source Nomo Harness package passes ordinary O2/cache-off source checking (zero diagnostics, 3.277 s). Its existing controlled `positive_prepare` entry completes with the original full-context, precharge and pending-proposal assertions: nine paired successful Console requests, zero model/filesystem/Memory/command/approval actions.

The **same exact 94 source files and hashes**, using the existing production `HistoryStages` implementation instead, fail before their first model request or Host action:

```
error[analysis::MissingCheckedFact]: checked record slot 0 does not hold field `task`
 --> /workspace/src/nomo/adapters/model/harness/history_native_stages.es:103:73
  | flow delegated(value: Delegation) -> string { return frame(["delegate", value.task]); }
  |                                                                         ^ checked record slot 0 does not hold field `task`
```

The imported type is declared at `nomo.domain.harness.typed_work_contract`:

```etas
public type Delegation = { task: string };
```

The source at the diagnostic is an ordinary read of that declared field:

```etas
import nomo.domain.harness.typed_work_contract.Delegation;
flow delegated(value: Delegation) -> string {
    return frame(["delegate", value.task]);
}
```

Production command: `etas --no-config --cache off run /workspace --flow production_stages --allow-effects --trace-out /fixture-evidence/production.trace.json`.

Actual: exit 3 in 4.996 s. Trace outcome is failed with Analysis(MissingCheckedFact), local_work_settled=true, no operations and zero Host request events. The local synthetic HTTP responder receives **zero requests**. No file read, edit, command, approval, or persistence action executes. Planned six-response/one-read assertions remain unexecuted, not accepted.

Expected: the checked declared Delegation.task projection should prepare, allowing this ordinary production consumer to reach inference. If a source contract is invalid, report it as such. This is the actual positive integration failure, **not a standalone/minimal reduction**. It does not establish whether the cause is layout selection, type identity, specialization or another checked-fact boundary, and no shared cause with #121/#123 is claimed. No workaround or relaxed projection check is selected.

The retained source fixture is `tests/fixtures/harness_prepare_interface001/controller_probe.es`, entry `production_stages`; the reproducible wrapper is `python3 -B tests/harness_prepare_ports_probe.py` (six scripted-local responses only; no real provider). Its first two launch attempts had owned obsolete-profile and missing-flow options; both stopped with zero HTTP, were corrected, and are retained separately. They are not the compiler observation reported here.

Exact official graph:
- CLI 9ed6827f16ee081cdaa327780941a3aee8b0c039 (0.24.6)
- Core e0be95b0f5b2ad0f52cb92ca23e88d00cce5ea9f
- Frontend 6ae9e9be24163c2da6d08c1cf53cf097ba13be6a
- Interpreter 4e1f7226e82afdc15ef140baabd7596f31870507
- Standard release binary SHA-256 b49158c9bbf4dbdc835062813b1fe7897fe38594693edeccf9c631226b10fd89
- Matching SDK artifact blake3:b7eafaeb1778b3fd091723803e8ad2cb065e827880bf40447907ad9857db12f3; body 99, metadata 78.

Linux/aarch64, ordinary 4 GiB / 4 CPU / 256 PID profile, peak 1,092,366,336 bytes and no OOM. Cache off, no compiler/source overrides or custom Rust flags. The source fixture now uses the actual application WorkRequest and stage effect instead of its obsolete CLI wrapper/callback; original assertions remain.

Exact source hashes, check/runtime outputs and both scopes: https://github.com/hrtan99/nomo/blob/refactor/etas-0230-architecture/examples/native-project/harness-prepare-ioc-0246-20261127.json
