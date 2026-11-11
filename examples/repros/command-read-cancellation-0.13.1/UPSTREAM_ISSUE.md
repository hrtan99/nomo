## Observed on the official 0.13.1 graph

- CLI `1e7877edad58f8a7dec92c0b9630cd19f6365020`
- core `cdb49367e73aadba56fbc89c984668ee3c1dd0aa`
- frontend `b09ceec7f57d1791dc92d358150cfc8c87935771`
- interpreter `9a63968fea9bdf958db79d70a6723b992154533d`
- CLI binary SHA-256 `9da7f127230b4b56233ba7fb350436d6d1021b4702b1e4a38d6eabb5c34a985e`
- Linux/aarch64, unprivileged Docker user. Official Cargo.lock, no source overrides or local compiler/Host patches.

The core and CLI main heads still match these revisions. A search for `Command.read` returned no issue; the current open core issue list contains only #56, on a different topic.

## Valid source and fixture

This uses the documented `race` cancellation behavior, not an outer handler that finishes a normal task body. The fixture starts a synthetic Python process, consumes its initial `ready` output, then races another blocked process read against console input. The private filesystem write only signals that the initial read completed. No model or application database is involved. The embedded program has no escaped backslash literal, so this is independent of frontend #84.

`src/app/main.es`:
```etas
module app.main;
import std.task.{run,race,Scheduler};
import std.host.command.{command,read,CommandEvent};
import std.host.command.start as spawn;
import std.fs.{Region,path,atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.io.{println,read_line,IOError};
public type State;
impl State ~ Region;
flow main(args:Array<string>)->i32 ![Async,Console,Command.start<DefaultCommandSandbox>,Command.read<DefaultCommandSandbox>,Fs.atomic_replace<State>,Error<FileError>,Error<IOError>] {
 return run((scheduler:Scheduler)=> {
  let process=spawn(command("/usr/bin/python3",["-u","-c","import time; print('ready',flush=True); time.sleep(300)"]),DefaultCommandSandbox);
  match read(process,65536) {
   CommandEvent.Output(output,error)=> {
    let location=match path<State>("ready") {Ok(value)=>value,Err(_)=>{abort("fixture state unavailable");}};
    atomic_replace(location,output);
   },
   _=>{abort("fixture did not produce its ready event");}
  }
  return race<i32,IOError>([
   ()=> {read(process,65536);return 1;},
   ()=> {println("WAIT_INPUT");read_line();return 0;}
  ]);
 });
}
```

`etas.toml`:
```toml
[package]
name="native-task-cancel"
version="0.1.0"
edition="2026"
[source]
root="src"
[runtime]
default_profile="local"
[runtime.profiles.local.command]
allow=["/usr/bin/python3"]
isolation="trusted-unconfined"
[runtime.profiles.local.filesystem.regions."app.main.State"]
root="/probe-state"
read=false
write=true
[runtime.profiles.local.policy]
mode="local-static"
rules=["console=allow","command=allow","filesystem=allow"]
[[bin]]
name="native-task-cancel"
module="app.main"
flow="main"
```

In the executed container, the package is mounted read-only at `/probe` and an existing, empty writable temporary directory at `/probe-state`. The latter is the fixture's `State` region and CLI trace destination. Run `etas pkg lock .`, then:

```sh
etas run /probe --allow-effects --trace-out /probe-state/trace.json
```

After `WAIT_INPUT`, submit one line. For a local run, bind the fixture's state region to an existing writable temporary directory; there is no consumer compiler patch or replacement process backend.

## Expected

The console branch returns 0. `race` requests cancellation of the losing blocked read, its backend operation settles, and the flow returns 0 promptly. Cancelling the read should not require stopping the background process or waiting for it to emit output. Buffered output must remain owned and available; dropping the Host operation registration to disguise unfinished work is not the requested fix.

## Directly observed

The source compiles and runs. The console branch consumes the supplied input in 19,406 microseconds, and the trace records `task_cancellation_requested` with reason `Requested` for the read task. Nevertheless the CLI remains running after the 10-second observation window. Inspection of the same container confirms that both Etas and the sleeping synthetic producer remain alive; the operation is not restarted.

For diagnosis/cleanup only, the test later sends SIGTERM to that one synthetic Python producer. The pending Host read then finishes and the flow exits 0. **That forced release is not a passing cancellation acceptance.** The total blocked read lasts 138,898,633 microseconds.

Captured Host trace facts (timestamps are Unix microseconds):

| Request | Action | Start | Finish | Duration |
| --- | --- | --- | --- | --- |
| 1 | Initial `Command.read` | 1794417129512725 | 1794417129519170 | 6,444 |
| 3 | Losing `Command.read` | 1794417129521253 | 1794417268419884 | 138,898,633 |
| 5 | Winning console read | 1794417129521477 | 1794417129540884 | 19,406 |

The explicit test-cleanup SIGTERM is recorded at Unix nanoseconds `1794417268419120797`; the blocked Host read finishes about 763 microseconds later. The task settles as `cancelled` only after that Host operation finishes. No scope-serialization event is present. The final runtime trace is `completed` after cleanup; the original cancellation requirement remains failed.

## Source inspection and requested behavior

The scheduler does request cancellation of the losing task. In the pinned [local command backend](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/command/local.rs), the process-operation path checks `operation.signal()` before dispatch, then the `Read` branch awaits `self.processes.read(...)` without observing cancellation while pending. [OperationContext::supervise](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/execution/operation/context.rs) correctly retains ownership until its backend job actually settles. This suggests that pending process reads need a cooperative cancellation/cleanup path in the backend; this cause is an inference from source, while the timing and continued liveness above are directly observed.

Please make cancellation settle the pending read without losing buffered bytes or leaving a stale pending-read slot. A real LocalCommandClient acceptance should race blocked command input/output with a normally completing sibling and finish while the producer is still alive. This report contains only official versions, synthetic fixture source and observed event metadata; no real project content or credentials.
