## Official 0.13.3, valid source

- CLI `7e23eb46a35f3095c173335f15af5692e9d75399`
- core `faa01c5752bfe3e46a187ee6e3def3911ab2430b`
- frontend `3abd9f84036845a06391d3ede4538eaf11af9bcf`
- interpreter `d175d32d8ecf0d3cba7bdbd8fe37e506ede06fa6`
- CLI binary SHA-256 `b45ff488a284e8484bc3bef9fa49adf05c35b6fe64220de6dd7728a6723bbb99`
- Linux/aarch64, official Cargo.lock, no source overrides or compiler/Host patches.

A scheduler owner writes one constant key in `owner-records`. Its child writes a different constant key in the separate `peer-records` region. The owner then waits for console input. The child is queued until that wait finishes, although the two Memory selectors are disjoint. This blocks a durable output collector from running alongside an interactive UI that uses Memory.

`src/app/main.es`:
```etas
module app.main;
import std.task.{run, start, Scheduler};
import std.io.{println, read_line, IOError};
alias Schema = MemoryRegion<{ Values: Store<string, i32> }>;
let Owner = std.memory.region<Schema>(stable_id = "owner-records", store = "owner");
let Peer = std.memory.region<Schema>(stable_id = "peer-records", store = "peer");
flow main(args: Array<string>) -> i32
    ![Async, Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return run((scheduler: Scheduler) => {
        Owner.Values.put("owner", 1);
        let child = start(() => {
            Peer.Values.put("peer", 1);
            println("CHILD_RAN");
            return 0;
        });
        println("WAIT_INPUT");
        read_line();
        return 0;
    });
}
```

`etas.toml`:
```toml
[package]
name = "task-memory-owner"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.memory]
backend = "sqlite"
path = "/probe-state/memory.sqlite3"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow", "memory=allow"]
[[bin]]
name = "task-memory-owner"
module = "app.main"
flow = "main"
```

Bind an existing writable temporary directory to `/probe-state` (the SQLite destination), run `etas pkg lock .`, then `etas run . --allow-effects --trace-out /probe-state/trace.json`. After `WAIT_INPUT`, leave input pending, then submit one line. The executed container has the source package mounted read-only and its `.etas` cache mounted as a private writable tmpfs.

## Expected

The child can write its independent Memory region and print `CHILD_RAN` while the owner is waiting for input. Conflicting resources must retain their guards. If the current fallback is intentional, please identify the supported Source ownership contract for a UI and a durable collector to progress concurrently.

## Directly observed

The package compiles and exits 0. During the observed 530,547-microsecond console wait, stdout contains only `WAIT_INPUT`. After submitting input, stdout becomes:
```text
WAIT_INPUT
CHILD_RAN
```

The native trace records two `task_scope_serialized` events with reason `unresolved_resource_selector`, both naming scope 0. The actual `run` scope is 1, with configured concurrency 65,536. The child is started in scope 1 but its Memory write is dispatched only after the owner's console read completes:

| Request | Action | Started, Unix microseconds | Finished, Unix microseconds |
| --- | --- | --- | --- |
| 0 | Owner `Memory.write` | 1794455526431458 | 1794455526432369 |
| 2 | Owner `Console.stdin_read_line` | 1794455526433134 | 1794455526963681 |
| 3 | Child `Memory.write` | 1794455526965377 | 1794455526968136 |

The SQLite database contains precisely the expected owner and peer records, each with value 1. There are zero model requests, command operations or filesystem effects in this reproduction. The overall trace is `completed`; successful completion after input does not establish concurrent child progress while input is pending.

## Source inspection and requested contract

The pinned [`resource_owner_needs_serial`](https://github.com/etas-project/etas-interpreter/blob/d175d32d8ecf0d3cba7bdbd8fe37e506ede06fa6/crates/etas_interpreter/src/eval/task_resource.rs) returns true for a plan with any Memory resources. [`execute_task_run`](https://github.com/etas-project/etas-interpreter/blob/d175d32d8ecf0d3cba7bdbd8fe37e506ede06fa6/crates/etas_interpreter/src/eval/task.rs) creates a new scope, then invokes `unresolved_resource_scope()` using the current parent task context when that check succeeds. This suggests the owner resource fallback is broader than the verified disjoint selectors, and explains the scope-0 trace label. This is an inference from source; the observed scheduling order above is directly measured.

Please preserve resource safety while supporting progress for verified disjoint owner/child Memory access, or expose/document the required public ownership mechanism. A collector must be able to persist output while its UI waits for input. The report contains only synthetic source, official versions and native event metadata; no project files or credentials are included.
