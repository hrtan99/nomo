## Published standard approve checks but escapes native Prompt dispatch

A one-source program importing the official `std.runtime.approval.approve` passes `check --all` with zero diagnostics, then exits 3 before any approval prompt with:

```
Analysis(UnhandledEffectAction): unhandled effect action std.effects.Approval.request escaped the checked-HIR interpreter entry
```

It prints only `BEFORE_APPROVAL`. The trace records the failed language outcome. The manifest enables `approval=allow` and approval mode `prompt`. No source-defined approval handler, model, Memory, filesystem, Command or credentials are involved.

```etas
module app.main;

import std.io.{println, IOError};
import std.effects.Approval;
import std.runtime.approval.{approve, Risk};

public flow main(args: Array<string>) -> i32 ![Console, Approval, Error<IOError>] {
    println("BEFORE_APPROVAL");
    let accepted = approve("Synthetic SDK approval", "synthetic payload only", Risk.Low);
    println(if accepted { "ACCEPTED" } else { "REJECTED" });
    return 0;
}
```

```toml
[package]
name = "standard-approval-0243"
version = "0.1.0"
edition = "2026"

[[bin]]
name = "repro"
module = "app.main"
flow = "main"
profile = "local"

[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "approval=allow"]

[runtime.profiles.local.approval]
mode = "prompt"
```

Commands (executed once in a fresh isolated directory):

```sh
etas --no-config --cache off check --all --format json .
etas --no-config --cache off run . --allow-effects --trace-out trace.json
```

Observed: check exit 0, one source, zero diagnostics; run exit 3; zero prompts/answers. Expected: the configured native Prompt service handles the canonical standard request, or the CLI documents/provides the required native binding for this published API.

Exact official graph: CLI 0.24.3 dd5768dc871b99fb4cc06c4532c772e257d2f64b; core 377875e8afb201a782e054b313fe7e529bcaa485; frontend bfe255314bc142fdd79a7c5d3d7f0cc77988574e; interpreter 5dfc2a121efb326107d461e08e66b31499db143b. Matching SDK compiler 0.21.3/body 98/metadata 78. Linux/aarch64, official release binary SHA-256 a172dd7a35541f91ebaa0fb4462f462fe76374bc8d3ffa6f2237a87e76d7d8f2. No patches, source overrides or custom Rust flags.

Primary-source integration lead, not a proven full root cause: [the published SDK](https://github.com/etas-project/etas-core/blob/377875e8afb201a782e054b313fe7e529bcaa485/crates/etas_std/library/std/runtime/approval/complete.es) performs typed `std.effects.Approval.request(ApprovalRequest<T>)` returning `ApprovalDecision`. [The interpreter native decoder](https://github.com/etas-project/etas-interpreter/blob/5dfc2a121efb326107d461e08e66b31499db143b/crates/etas_interpreter/src/eval/boundary_approval.rs) matches path name `Approval` and exactly one string reason. Please reconcile canonical standard request/decision identity with the configured Host binding and trusted approval provenance. A same-spelled source effect or a source handler returning Accepted is not evidence of native authority.

The complete Nomo canonical-API candidate independently checks all 444 product modules, then the existing real-edit smoke fails at the same standard request before any confirmation, intent or write. It is retained unselected; we have not bypassed this with a boolean bridge. An ordinary scoped source-handler reduction checks successfully, so this report does not claim that all generic standard handlers fail.

Public payload is only this synthetic program/configuration, public graph pins and observed diagnostics. No private source, credentials or real project data.
