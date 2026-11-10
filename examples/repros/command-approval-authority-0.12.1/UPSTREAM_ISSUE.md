## Observed on official ETAS 0.12.1

During a positive native file batch/undo integration, all requested operations completed and original text, binary files, directories and a Unix file mode were restored. There were 30 native Command Host executions, two filesystem atomic replacements and 32 separate human approval prompts, each answered only after the synthetic operation preview matched. The approval provenance audit then failed: each actual Command Host request/trace carried its pre-approval authority snapshot, missing the grant just obtained for that boundary.

This observation does **not** establish an approval bypass: each command prompted before execution. It is a request/trace authority consistency defect affecting audit and any Host consumer that needs the current approval provenance.

## Official graph

- CLI 0.12.1 `a3c49ffb19d2b3770c9232eb975f605fcf6ac876`
- core `0f599a84dd00c3abe71f6549004776672f62f02f`
- frontend `88764266e384ae8035f44892c9093aabc1761d0f`
- interpreter `cb8c48c0d09c78ce24201ceb13d2ec72a14a2555`
- Linux/aarch64 binary SHA-256 `fb3e472c80a3b3e33829e47f22188ea6513cc708a040f9845774eb6d42f7211e`
- No source/dependency overrides or runtime patches. Local synthetic model only, no provider or credentials.

## Actual trace excerpt

The numbers below are the zero-based event positions and request IDs in the observed run. Counts are cumulative inside the source tool; they should not be assumed to be exactly one.

| Event | Request | Action | approval_count |
|---|---:|---|---:|
| 174 | 10000074 | Approval.request | 0 |
| 175 | 10000074 | host_request_finished | — |
| 176 | 73 | Command.run | 0 |
| 293 | 10000122 | Approval.request | 1 |
| 294 | 10000122 | host_request_finished | — |
| 295 | 121 | Command.run | 1 |
| 698 | 10000284 | Approval.request | 5 |
| 699 | 10000284 | host_request_finished | — |
| 700 | 283 | Fs.atomic_replace | 6 |

The first command should carry its just-obtained approval rather than zero approvals. The second command should include its own new approval, rather than only the previous one. The filesystem replacement illustrates the expected post-policy snapshot. The source file tool performed actual native calls; Python only provided terminal transport, local synthetic model replies, fixture setup and assertions.

## Pinned source path

In interpreter `crates/etas_interpreter/src/driver/dispatch/command.rs`, `begin` calls `evaluate_before_boundary(...)`, which obtains and records approval in the evaluation context. It then passes the existing `command.request.authority.clone()` to `HostDispatch::begin` and dispatches `host.command(..., command.request.clone())`. The request was created before approval, and this path does not refresh its authority from the updated evaluation context.

Please carry the current boundary's validated approval into the actual CommandRequest and its trace, maintaining its binding to the pending command and the existing replay/cancellation semantics. A numeric trace count alone is not a sufficient long-term grant-binding assertion; this count mismatch exposed the stale request in the positive flow.

## Reduced recipe

The integration observation above is executed evidence. This dependency-free standalone recipe is reduced from it and has not been run separately, to avoid redundant testing. Use edition 2026, module `app.main`, flow `main`, a ProjectRoot region bound to `/tmp`, `/bin/echo` allowed with `trusted-unconfined` isolation, local static `command=approval`, `approval=allow`, and prompt approval mode.

```etas
module app.main;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};

type ProjectRoot;
impl ProjectRoot ~ Region;

flow main(args: Array<string>) -> i32 ![Command.run<DefaultCommandSandbox>] {
    let cwd = match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => { abort("invalid cwd"); } };
    let first = run(with_cwd(command("/bin/echo", ["first"]), cwd), DefaultCommandSandbox);
    let second = run(with_cwd(command("/bin/echo", ["second"]), cwd), DefaultCommandSandbox);
    return first.exit_code + second.exit_code;
}
```

Run `etas run . --allow-effects --trace-out trace.json` and approve both echo commands. Inspect the authority passed to Command Host requests and their trace events. No local compiler patch, fake approval flags or replacement dispatcher is used in the application.
