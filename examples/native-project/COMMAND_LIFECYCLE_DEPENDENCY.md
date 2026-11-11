# Native process lifetime dependency — official 0.13.1

The full native migration needs background jobs and their output to survive leaving Nomo, with live input/output/stop after a new process starts. Saved metadata/output alone does not satisfy live reattachment.

## Capabilities now implemented and accepted

The original command acceptance used official ETAS CLI 0.13.0 `6ceb644a17b159a5ee9a988cbbba0700aebf5e46`, core `cdb49367e73aadba56fbc89c984668ee3c1dd0aa`, interpreter `7422fb134d2606cc28b7af9c69e98668ba5411c0`, frontend `b09ceec7f57d1791dc92d358150cfc8c87935771`. The current official 0.13.1 graph is recorded in `config/etas-latest-main.json`; the resident-worker evidence below uses that version.

The [public command module](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_std/src/modules/host/command.rs) now exposes `start`, `id`, `reconnect`, `read`, `write`, `close_stdin` and `stop`. Nomo uses these actual operations, with per-conversation job ownership and separate native approval for every boundary. Actual Unicode echo input/output, EOF/exit, stopping another process and saved-output restoration pass. Source/artifact identities: `processes-0130-20261111.json`.

## Remaining lifetime / PTY scope

The [local backend registry](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/command/local/process.rs) stores process records in an in-memory `Arc<Mutex<HashMap<...>>>` owned by a `LocalCommandClient`. `reconnect` looks up that client's registry. It supplies no external persistent Host/service or fresh-client registry reconstruction. The [protocol](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/command/protocol.rs) starts stdin/stdout/stderr pipes; there is no PTY selection or terminal-size operation.

Actual product acceptance, `python3 -B tests/native_process_reconnect_probe.py`: native `/spawn`, `/poll`, `/jobs`, normal exit, then a fresh native launcher with the same conversation. The new process restores job metadata, obtains native approval for reconnect and fails with `background command is not available for reconnection`. Exit status 3; zero model requests; all four native approvals pass the strict provenance audit. Evidence: `process-reconnect-0130-20261111.json`. This remains a failed acceptance, not a passing unavailable-job fallback.

The launcher now keeps the actual Etas worker, including its `LocalCommandClient`, alive across terminal-client detach/reconnect. `tests/native_worker_probe.py` positively accepts one client starting two jobs, detach, a new client sending Unicode input to the original job, reading its output, closing input and observing exit, and stopping the other original job. The exact container, PID and start time stay unchanged; 16 native command operations pass the approval audit. A subsequent actual Host shutdown/new Host restores the saved conversation and raw output. Evidence: `worker-0131-20261111.json`. A container that merely stays alive while replacing its Etas process would not provide this guarantee.

Use Ctrl+P then Ctrl+Q to detach. `/quit`, project remount, fatal runtime failure or container loss ends the Host. Host/container crash survival remains unaccepted; recording a PID or opaque handle cannot recreate its pipes or PTY. Providing that stronger lifecycle would require a separately reachable native command backend plus CLI/embedding support. Native command children still use pipes and cannot select a PTY or resize it. Soft command wait timeouts and continuous output collection also remain incomplete; the Host's unread-output bounds still apply while detached.

Python only identifies/starts the container and transports terminal bytes. It does not manage the tool subprocesses, open conversation storage, decide task recovery or supply task/approval answers. No compiler/Host patch is installed. Nomo-owned resident-worker work is distinguished from the remaining upstream PTY/backend API scope; these feature gaps are not asserted to be regressions of the existing same-Host API.
