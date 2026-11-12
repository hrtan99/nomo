## 0.13.4 consumer follow-up: original case fixed; computed log keys still block progress

The original #108 package passes unchanged on official CLI 0.13.4. Its child now writes during the owner console wait, with zero serialization events. Thank you for the scoped fix.

The full native output-capture consumer still dispatches zero `Command.read` requests during a 20-second UI input wait: its capture head remains at zero events, and the trace records `unresolved_resource_selector`. Normal quit completes. The same candidate that failed on 0.13.3 was applied unchanged; its code and positive scenario are retained in the [public candidate patch](https://github.com/hrtan99/nomo/blob/267918a/examples/native-project/candidates/native-output-capture-0133.patch). This is separate from the accepted constant-selector reproduction.

A smaller remaining case uses the same two independent Memory regions, but the child appends `part-0` and `part-1` with a computed key. It compiles and exits 0, yet the child writes still occur only after input ends.

Official graph (no overrides or compiler/Host patches): CLI `256b2e0c58f2bb9dbdc158e1dc298f4bbf35eec6`, core `faa01c5752bfe3e46a187ee6e3def3911ab2430b`, frontend `821780a02120ded06ddd601c3a3d358b85436101`, interpreter `31bcd4ad16b6cac05f71e093341536329c48c80f`. Binary SHA-256 `46c94628f825e4e84a952a59619331651f074edc13be61a1876606f8c5e87320`.

```etas
module app.main;
import std.task.{run, start, Scheduler};
import std.io.{println, read_line, IOError};
import std.text.from_i32;
alias Schema = MemoryRegion<{ Values: Store<string, i32> }>;
let Owner = std.memory.region<Schema>(stable_id = "owner-records", store = "owner");
let Peer = std.memory.region<Schema>(stable_id = "peer-records", store = "peer");
flow main(args: Array<string>) -> i32
    ![Async, Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return run((scheduler: Scheduler) => {
        Owner.Values.put("owner", 1);
        let child = start(() => {
            var index: i32 = 0;
            while index < 2 limit Iterations(2) {
                Peer.Values.put("part-" + from_i32(index), index);
                index = index + 1;
            }
            println("CHILD_RAN");
            return 0;
        });
        println("WAIT_INPUT");
        read_line();
        return 0;
    });
}
```

```toml
[package]
name = "task-memory-log"
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
name = "task-memory-log"
module = "app.main"
flow = "main"
```

Bind an existing writable temporary directory at `/probe-state`, run `etas pkg lock .`, then `etas run . --allow-effects --trace-out /probe-state/trace.json`. Leave input pending after `WAIT_INPUT`, then submit one line.

Observed stdout during the input wait: `WAIT_INPUT`. Only after input is submitted does `CHILD_RAN` appear. One `task_scope_serialized` event has reason `unresolved_resource_selector` and names scope 0. Native Host times (Unix microseconds):

| Operation | Start | Finish |
| --- | --- | --- |
| Owner console read | 1794462062899888 | 1794462063456697 |
| Child first Memory write | 1794462063457606 | 1794462063460156 |
| Child second Memory write | 1794462063460387 | 1794462063462061 |

The owner record and both child records persist correctly. This reproduction performs zero model, command or filesystem effects; it isolates scheduling rather than storage correctness. Final exit 0 does not establish progress while input is pending.

Source inspection suggests that a computed/mutated key makes the resource plan incomplete before an immutable store/region can supply a coarser guard. This may be the intended conservative fallback; I am reporting the remaining consumer limitation, rather than requesting guard bypass or claiming that the original constant-selector fix failed. What supported Source ownership contract lets a durable append-only collector progress alongside a Memory-using UI? A verified store/region-level guard for unknown keys, or a documented public ownership mechanism, would preserve conflict safety while covering this workflow. The complete consumer's dynamic selectors and ordinary Source behavior-interface calls should be included in that contract.

This follow-up contains only official versions, synthetic source and observed event metadata. No real project files or credentials are sent.
