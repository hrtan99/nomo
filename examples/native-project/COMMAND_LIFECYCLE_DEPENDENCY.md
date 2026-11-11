# Native process lifetime dependency — official 0.13.0

The full native migration needs background jobs and their output to survive leaving Nomo, with live input/output/stop after a new process starts. Saved metadata/output alone does not satisfy live reattachment.

## Capabilities now implemented and accepted

Official ETAS CLI 0.13.0 `6ceb644a17b159a5ee9a988cbbba0700aebf5e46`, core `cdb49367e73aadba56fbc89c984668ee3c1dd0aa`, interpreter `7422fb134d2606cc28b7af9c69e98668ba5411c0`, frontend `b09ceec7f57d1791dc92d358150cfc8c87935771`.

The [public command module](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_std/src/modules/host/command.rs) now exposes `start`, `id`, `reconnect`, `read`, `write`, `close_stdin` and `stop`. Nomo uses these actual operations, with per-conversation job ownership and separate native approval for every boundary. Actual Unicode echo input/output, EOF/exit, stopping another process and saved-output restoration pass. Source/artifact identities: `processes-0130-20261111.json`.

## Remaining lifetime / PTY scope

The [local backend registry](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/command/local/process.rs) stores process records in an in-memory `Arc<Mutex<HashMap<...>>>` owned by a `LocalCommandClient`. `reconnect` looks up that client's registry. It supplies no external persistent Host/service or fresh-client registry reconstruction. The [protocol](https://github.com/etas-project/etas-core/blob/cdb49367e73aadba56fbc89c984668ee3c1dd0aa/crates/etas_host/src/command/protocol.rs) starts stdin/stdout/stderr pipes; there is no PTY selection or terminal-size operation.

Actual product acceptance, `python3 -B tests/native_process_reconnect_probe.py`: native `/spawn`, `/poll`, `/jobs`, normal exit, then a fresh native launcher with the same conversation. The new process restores job metadata, obtains native approval for reconnect and fails with `background command is not available for reconnection`. Exit status 3; zero model requests; all four native approvals pass the strict provenance audit. Evidence: `process-reconnect-0130-20261111.json`. This remains a failed acceptance, not a passing unavailable-job fallback.

The current Docker launcher is disposable, so its exit also ends that container's processes. Keeping a persistent environment alone would not reconstruct the fresh local client's in-memory registry. Nomo needs a supported native Host whose process identities and output remain reachable across client restart, including reconciliation of stale/terminated processes, plus PTY support for the existing interactive-terminal behavior. Its source should receive real status/cancellation outcomes and retain recovery decisions; a stored ID must not be treated as proof of liveness.

No Python process manager, detached shell supervisor or local compiler/Host patch substitutes for this missing lifetime. The missing scope is documented as an upstream capability dependency; it is not asserted to be a regression of the newly provided same-Host API. No new upstream bug issue is published from this note.
