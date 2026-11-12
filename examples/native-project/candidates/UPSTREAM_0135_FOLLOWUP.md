## 0.13.5 consumer follow-up: computed-key reproduction fixed; full collector still does not run

The unchanged computed-key package from the previous comment now passes on official CLI 0.13.5: both child Memory writes finish while console input is pending, with zero scope-serialization events. The dynamic-key fix is accepted for that scope.

I then applied the same [complete Nomo Source candidate and positive scenario](https://github.com/hrtan99/nomo/blob/267918a/examples/native-project/candidates/native-output-capture-0133.patch) to the [official-0.13.5 Nomo baseline](https://github.com/hrtan99/nomo/tree/fddb4ed). The actual `scripts/nomo-native` entry still fails continuous collection:

| Observation | Result |
| --- | --- |
| Approved synthetic producer | One `Command.start` |
| UI left waiting for input | 20 seconds, no `/poll` or model request |
| `Command.read` requests | 0 |
| Saved capture events / bytes | 0 / 0; expected 2,555,904 bytes |
| `task_scope_serialized` | Two events, both `unresolved_resource_selector`, scope 0 |
| Normal `/quit` | Completes, flow returns 0 |

The failure is before the scenario's fresh-Host restoration and partial-read checks; those later checks have not passed. The accepted non-capture native read/edit/check/Git/chat/fresh-Host workflow passes on this same compiler. Product source was restored exactly to that accepted baseline; the capture proposal is not shipping.

Official graph, without overrides or compiler/Host patches: CLI `826bf13bea02f1c1468e6b97b8d2ec7dad2ebc0e`, core `faa01c5752bfe3e46a187ee6e3def3911ab2430b`, frontend `bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1`, interpreter `3c0b78fbf147e5bb2fc33e13a501a88b97411d1c`. Binary SHA-256: `9be1cb60d532d954538b72206507e27439a427402c67cf384249831bc304c2f2`. Trace SHA-256: `6549ea6220b4a8d934ccc8a53cf4e88fb8f00082e21433a33f2ba4921fa1873b`.

To exercise the full public consumer on that baseline, apply `examples/native-project/candidates/native-output-capture-0133.patch`, then run `python3 -B tests/native_capture_probe.py` using the repository's native Docker setup. This is the same positive scenario, not another reduced test.

### Pinned-source inspection of the remaining consumer paths

Inspection of the exact released revisions identifies several conservative paths present in the complete candidate:

- The collector calls `Captured.Chunks.insert(...)`. The [standard library registers `insert` as `MEMORY_INSERT`](https://github.com/etas-project/etas-core/blob/faa01c5752bfe3e46a187ee6e3def3911ab2430b/crates/etas_std/src/modules/memory.rs#L273-L287), but the [resource scanner's supported keyed operations](https://github.com/etas-project/etas-frontend/blob/bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1/crates/etas_frontend/src/passes/analysis/concurrency/resource.rs#L172-L188) omit it. The non-keyed supported set is only keys/page/scan/clear, so an insert does not receive the same complete store guard as the accepted put-based reproduction.
- The collector calls `describe(job, -1, read(process, 65536))`. The [ordinary Source-flow call scan](https://github.com/etas-project/etas-frontend/blob/bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1/crates/etas_frontend/src/passes/analysis/concurrency/resource.rs#L235-L250) requires every argument to be a literal or an immutable path; the nested read argument makes that plan incomplete, independently of the computed log key.
- The complete UI invokes native inference and uses the Source `ProcessCapture.register` effect. The [scanner marks `Perform` and `Infer` incomplete](https://github.com/etas-project/etas-frontend/blob/bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1/crates/etas_frontend/src/passes/analysis/concurrency/resource.rs#L267-L274). These complete-consumer paths are absent from the accepted two-put reproduction.
- The [runtime rejects an incomplete resource plan](https://github.com/etas-project/etas-interpreter/blob/3c0b78fbf147e5bb2fc33e13a501a88b97411d1c/crates/etas_interpreter/src/eval/task_resource.rs#L45-L54), and [task admission calls invocation serialization](https://github.com/etas-project/etas-interpreter/blob/3c0b78fbf147e5bb2fc33e13a501a88b97411d1c/crates/etas_interpreter/src/eval/task.rs#L480-L489) when it cannot resolve those resources. This matches the observed reason, without identifying which path caused each particular trace event.

These are static-source findings, not additional executed tests or proof that changing one path would make the full collector pass. No operation, resource guard or compiler code has been changed to avoid the fallback. The UI also reads published log state, so the supported contract must cover real publication/read ownership, not just two entirely unrelated stores.

The remaining full-consumer root cause is not exhausted by these findings. Could you exercise this complete Source consumer and identify the supported ownership contract for a persistent-Memory UI plus a durable append-only background collector? If the current Source shape is unsupported, a documented safe ownership/API requirement would let Nomo implement it without disabling resource guards or moving the business loop back into Python. The fixed reduced case is not being reclassified as a failure.

This follow-up contains only official identities, public candidate source and observations from a synthetic producer. No real project files, credentials or provider requests are involved.
