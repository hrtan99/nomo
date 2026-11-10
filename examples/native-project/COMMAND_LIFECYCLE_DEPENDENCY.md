# Native interactive process dependency

The full native migration requires retained background and interactive processes, incremental output, input, stopping, and attachment after a new Nomo process starts. Foreground command completion alone does not satisfy this requirement.

## Inspected official graph

ETAS CLI 0.12.1 `a3c49ffb19d2b3770c9232eb975f605fcf6ac876`, core `0f599a84dd00c3abe71f6549004776672f62f02f`, interpreter `cb8c48c0d09c78ce24201ceb13d2ec72a14a2555`, frontend `88764266e384ae8035f44892c9093aabc1761d0f`.

The public [command module](https://github.com/etas-project/etas-core/blob/0f599a84dd00c3abe71f6549004776672f62f02f/crates/etas_std/src/modules/host/command.rs) exposes command construction, environment, region-bound cwd, pre-supplied stdin and synchronous `run`. `CommandHandle` is declared, but this module registers no handle-producing spawn or handle-consuming poll, send, stop or attach operation.

The [Host command protocol](https://github.com/etas-project/etas-core/blob/0f599a84dd00c3abe71f6549004776672f62f02f/crates/etas_host/src/command/protocol.rs) takes complete optional stdin and returns an exit code and collected stdout/stderr. The current public boundary has no job identity or incremental stream cursor.

The [structured task API](https://github.com/etas-project/etas-core/blob/0f599a84dd00c3abe71f6549004776672f62f02f/crates/etas_std/src/modules/task/flows.rs) supports scheduler-owned tasks. Scheduling synchronous command work does not supply the missing interactive process input/output or a retained external process identity after the scheduler exits.

## Required supported contract

The source program needs a checked native operation to start a process with an actual cwd/argv/PTY or stream binding and obtain a durable process identity; read output by cursor without dropping the original log; send input; stop the owned process; and attach or reconcile its status after a new process starts. Each mutation needs policy/approval bound to the particular process and operation. Native source must receive cancellation, completion and uncertain outcomes so that it can own task recovery.

This is a documented upstream capability dependency, not an accepted native implementation. No Python process manager, shell-detached process service, local compiler patch or invented `CommandHandle` methods stand in for it. The existing Python product process manager remains outside the opt-in native path, and the official default entry cannot be switched to the complete native product until this requirement is met. This note has not been published as an upstream issue.
