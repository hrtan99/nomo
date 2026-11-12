# Remaining Etas capabilities for the complete native Nomo product

This is a capability contract, not a list of confirmed compiler bugs. The current official graph is 0.13.4 in `config/etas-latest-main.json`. It includes the accepted #65 pending-read cancellation fix and now accepts #108's original independent constant-Memory-selector case. Full product capture with dynamic log keys remains separate from that original proof. The other source-visible contracts below are unchanged. No compiler patch or Python business implementation is substituted. The default entry remains the existing product until the complete native scope is accepted.

## Layer ownership

| Layer | Responsibility |
| --- | --- |
| Standard library (`etas_std`) | Source-visible types, functions, effects and documented semantics. Declaring an interface does not implement the external operation. |
| Execution engine/runtime (currently `etas-interpreter`) | Language evaluation, task scheduling, effect dispatch, language policy/admission, approval association, limits, continuations and checkpoint handling. |
| Host (`etas_host` and its adapters) | Engine-neutral requests and adapters that actually contact an OS process, filesystem, model service, database or approval UI. The current local Host is inside the Etas process; Host does not inherently mean a separate server. |
| Nomo's Etas source | Project/session selection, interaction, context policy, tool implementations, history/journals, task ownership and recovery decisions. |
| Environment transport | Container mounts, invoking identity, endpoint/terminal connection and byte forwarding. It does not read the business database or decide model/tool stages. |

Source: [official Host ownership design](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/docs/architect/etas-host-design.md). Exact source filenames below refer to that pinned graph, not an assertion about future releases.

The minimum upstream work is: a supported dynamic Memory ownership contract for the UI/capture product path; PTY/control-terminal operations; a supported timed-wait path; a per-model-round context projection contract; and dynamic inference options with source-visible usage. Each needs the source interface and the implementation at its owning boundary. Continuous output draining and summarization policy remain Nomo source work. Retaining jobs after destruction of the Etas Host is a separate, stronger lifecycle requirement than client detach/project switching, which already retain that Host.

## Required public contracts

### PTY and terminal controls

- Standard library: choose pipe/PTY on start, set initial rows/columns, resize the terminal, and distinguish interrupt from terminate/close-input. Signal API names should be decided upstream.
- Runtime: lower and dispatch those operations, preserve checked process ownership and approval/trace association, and keep cancellation scoped to the intended operation.
- Host: allocate the actual PTY/control terminal, apply terminal size changes and signal the actual process group; return real output and terminal outcomes.
- Acceptance: a child observes `isatty() == true`, sees changed terminal dimensions, receives interactive input and an interrupt, and Nomo remains usable after the command settles.
- Existing support: pipe-based start/read/write/close-stdin/stop/reconnect already works. This request extends that API; it does not claim background commands are absent.

Sources: `crates/etas_std/src/modules/host/command.rs`, `crates/etas_host/src/command/protocol.rs`, `crates/etas_host/src/command/local.rs` in etas-core.

### Per-round context control

Provide either a supported before-next-request context hook in the native tool loop, or a complete source-owned loop API. The latter needs readable assistant content/tool calls/IDs/usage, supported tool dispatch preserving typed arguments and authority, and assistant/tool message construction preserving call/result pairing. An opaque response alone is insufficient.

- Standard library: declare the chosen public contract. Unsupported private checkpoint/debug JSON is not a source API.
- Runtime: expose the round boundary or response/dispatch/message operations while retaining tool IDs, typed decoding, approval and cumulative budget ownership. A new inference must not silently reset the enclosing task budget.
- Host: retain the existing provider protocol transport and usage reporting; no Nomo-specific summary policy belongs here.
- Nomo: decide when to summarize, retain original history, select the recent suffix and feed the resulting projection back before the next model request.
- Acceptance: a single tool-using inference exceeds the projection threshold, compresses between two model requests, then continues the same task with valid tool pairing and complete original history.

`infer<ModelResponse>` now returns after the official #104 fix. The executed 0.13.1 probe returns `None` from optional JSON projection; the pinned standard schema module exposes no response field accessors. This is an observed API limitation, not a new compiler bug report. Current large-history compaction evidence covers before-inference compaction only. Sources: `crates/etas_std/src/modules/agent/{schema,prompt}.rs` and interpreter `src/eval/{host_value/projection,machine/model}.rs`.

### Dynamic inference limits and source-visible usage

- Standard library: source-visible per-call inference options and readable reported usage. Distinguish per-request output cap, per-request context capacity and cumulative task allowance.
- Runtime: validate dynamic options, enforce the limits at the corresponding scope, and preserve cumulative accounting across tool rounds. Existing static `@limits` and runtime usage settlement should remain effective.
- Host: translate output options to provider parameters and return actual reported usage, including an explicit unavailable state when not reported.
- Acceptance: two calls use different configured output caps observable in the actual HTTP payload; the source ledger receives the actual usage of all rounds without confusing allowances with measured usage.

Current Nomo status: static 131072 output cap, 536870912 cumulative coding allowance, and a separate estimated projection window. A different configured output cap is explicitly not submitted. A number in prompt data is not enforcement. Sources: std `modules/runtime/{limits,budget}.rs` and interpreter `eval/limit.rs`.

### Soft terminal wait and continuous output

Nomo's existing `command_timeout` means return a retained job after the wait, not kill its process. A supported timed/cancellable read or sufficient source-level timer/task primitives must distinguish no-output-yet, EOF and terminal outcome. Cancelling a wait must not consume unrecorded output or destroy the background job. Source-owned draining/journalling is Nomo work where these primitives suffice; configurable buffering/spooling belongs to the Host if needed beyond its current unread-output bounds.

Acceptance: a long command returns a live handle after the configured wait, then its actual later output and exit remain readable. Continuous-output acceptance must exceed the current Host buffer scope before claiming unbounded or complete detached output collection. Current `/poll` waits for the next output/terminal event and `command_timeout_active=false`; this requirement is unaccepted.

The earlier cancellation defect [etas-core#65](https://github.com/etas-project/etas-core/issues/65) is fixed by official 0.13.3. The same valid source now settles the losing pending read with `Cancelled` in 911 microseconds and returns 0; there is no explicit producer termination or `Command.stop`. `command-read-cancellation-0133-20261112.json` records the acceptance, while the 0.13.1 failure remains historical. This removes a Host defect; Nomo still owns continuous capture, durable log publication and orderly task-scope shutdown. A timed wait also still needs a public timer/read-timeout contract.

### Task progress alongside persistent Memory

The earlier 0.13.3 actual-entry capture candidate exposed [etas-interpreter#108](https://github.com/etas-project/etas-interpreter/issues/108). Official 0.13.4 now passes the unchanged constant-selector reproduction without scope serialization. The full candidate with dynamic log keys still requires its own product acceptance. Its approved producer starts, but no native read runs while the UI waits for input; the capture head remains empty. In the historical 0.13.3 run, the smaller valid source used two independent Memory regions and constant keys, and its child write waited until the owner's console read finished. This observed scheduling limitation is separate from the fixed pending-read cancellation defect.

The unchanged actual candidate has now been executed on 0.13.4 and still saves zero output events during a 20-second UI wait; it dispatches no `Command.read`. A separate reduced computed-key log reproduces the remaining serialization with independent regions. The original constant-key case is accepted as fixed. The remaining consumer limitation and request for a supported ownership contract are recorded in the [#108 follow-up](https://github.com/etas-project/etas-interpreter/issues/108#issuecomment-6815750299) and `task-memory-log-0134-20261112.json`; conservative fallback is not bypassed or automatically classified as a new compiler defect.

- Standard library: a supported, documented ownership contract for disjoint persistent resources across a scheduler owner and its children. The existing `run`/`start` interface should make the required ownership and serialization behavior usable from Source.
- Runtime: preserve genuine conflict guards while allowing verified disjoint owner/child resources to progress during Host waits. The current owner resource fallback emits `unresolved_resource_selector` on scope 0, even for the reduced independent regions.
- Host: the two SQLite writes eventually succeed; this reproduction does not identify a storage-backend failure or require a new model/command transport.
- Nomo: retain a single writer for each capture stream, independent log publication/read cursors, and normal cancellation/restore semantics. The failed implementation and its positive acceptance scenario are preserved as `candidates/native-output-capture-0133.patch`; the validated product source is restored unchanged.

Exact minimal source, native event times, candidate failure and public-report identity: `task-memory-owner-0133-20261112.json` and `examples/repros/task-memory-owner-0.13.3/`. Complete native capture remains unaccepted; no resource guards are disabled to hide serialization.

## Stronger execution-endpoint restart survival

Ordinary terminal-client restart and project switching are now handled by Nomo's resident Etas workers. `native_worker_probe.py` accepts detach/new-client live I/O/stop in the same Host. `native_projects_probe.py` accepts A→B→A with the original live job and reconnecting B through a later startup chooser. Neither is an upstream blocker.

Surviving destruction of that Host is stronger: a separately reachable native process backend must retain process identities, pipes/PTY, output and exit states. The runtime/CLI needs supported backend binding and fresh authority checks; standard `reconnect` needs documented lifecycle guarantees. Saving a PID or handle cannot recreate lost file descriptors. A backend's own crash guarantee must be specified separately; a daemon does not automatically solve its own crash.

This stronger guarantee is not currently accepted. `/quit`, fatal runtime failure and container loss end the local Host. Project selection now detaches the client and retains that Host. No automatic restart/replay is used to disguise the gap.

## Delivery status

The native read/edit/check/Git/chat/shutdown/fresh-Host history workflow and strict approval audit pass. Resident-client reconnect is accepted separately. Native command PTY parity, in-loop compaction, dynamic configuration, soft wait/output lifecycle and final default cutover remain incomplete. Project selection, history schemas, compression policy and recovery decisions remain Nomo responsibilities; this document does not ask Etas upstream to implement Nomo business behavior.
