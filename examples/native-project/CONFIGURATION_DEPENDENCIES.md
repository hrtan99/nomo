# Native project configuration contracts and remaining dependencies

Native `.nomo.toml` loading now retains the optional `[project]` table, omitted field defaults and ignored unrelated keys. Etas owns key selection, defaults, type/value validation, instructions, discovery ignore patterns, configured check argv, context estimates, recent-message selection and the persistent parsed cache. The executed positive flow includes full configuration, multiline Unicode instructions, actual configured tools, summary/restore, a cache hit in a new process and a changed partial root configuration. Full native delivery remains unaccepted at the command approval audit and the dependencies below.

## Generic data codecs

The native Command Host runs fixed Taplo 0.10.0 with `get -o json` on exact UTF-8 stdin. A second native Command Host call runs the generic jq filter `walk(if type == "object" then to_entries else . end)`. The filter contains no Nomo field names or policy. Each argv/stdin pair is previewed and separately approved by the actual runtime. Etas projects the resulting arrays into `{key: string, value: JsonValue}` entries, then makes all configuration decisions itself. No Python or shell business controller is involved.

The cache binds the raw file's native SHA-256 digest to its complete, archived codec result event. An unchanged file, including after a new process, needs no repeated decoder command or approval. A changed file is decoded again. Parsed configuration is derived state; original command inputs/results remain in native history.

Run `./scripts/nomo-native-tools.sh` to install the fixed generic TOML decoder into its isolated tool directory. jq is already part of the Nomo image. `config/native-tools.json` records the dependency contract. The official Etas graph and binary are unchanged.

The executed observation in `examples/repros/json-object-access-0.12.1` explains the representation choice. JSON objects project to complete closed records; the inspected strict map cast expects the different key/value-map representation. The registered `std.json` module exposes parse/stringify without object lookup. This is not asserted as a compiler bug. The entry-array codec preserves existing validation and the complete configuration contract.

Sources: [Taplo conversion](https://taplo.tamasfe.dev/cli/usage/conversion-and-extraction.html), [jq entries/walk](https://jqlang.org/manual/), [pinned JSON API](https://github.com/etas-project/etas-core/blob/0f599a84dd00c3abe71f6549004776672f62f02f/crates/etas_std/src/modules/core/json.rs), [map representation](https://github.com/etas-project/etas-core/blob/0f599a84dd00c3abe71f6549004776672f62f02f/crates/etas_host/src/value/json.rs), [checked decoding](https://github.com/etas-project/etas-interpreter/blob/7422fb134d2606cc28b7af9c69e98668ba5411c0/crates/etas_interpreter/src/eval/host_value.rs).

## Model limits

`context_window` and `compact_ratio` control native text-estimate admission and compaction; `keep_messages` controls the recent suffix, also subject to its byte budget. `/config` distinguishes the requested settings, estimated effective window and static per-request output cap and cumulative inference allowance. These estimates are not measured provider token usage or a dynamic replacement for the runtime's token ceiling.

The current native coding agent has a static 131072 per-request output cap and 536870912 cumulative input/output token allowance for its tool loop. The estimated per-request window remains capped at 1048576; it is distinct from that cumulative allowance. The summary agent has a static 32768 output cap and 1048576 cumulative allowance. The pinned [limit evaluator](https://github.com/etas-project/etas-interpreter/blob/7422fb134d2606cc28b7af9c69e98668ba5411c0/crates/etas_interpreter/src/eval/limit.rs) requires static integer literals. Arbitrary per-call `max_output_tokens` settings need a supported runtime API. Requests with another configured coding output allowance are explicitly not submitted; putting a number in prompt data is not enforcement.

## Retained terminal timing

`command_timeout` is parsed and retained, but `/config` reports `command_timeout_active=false` and the agent is told it is inactive. In the existing product it means returning a retained job after the wait period. The inspected native Command API exposes synchronous run and initial stdin; retained handles, poll/input/stop and restart attachment remain in `COMMAND_LIFECYCLE_DEPENDENCY.md`. Killing the process at the timeout would change the required behavior.

The default shipping entry remains unchanged until the complete native product and full acceptance gates are satisfied.
