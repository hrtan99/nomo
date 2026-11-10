# Native Etas migration — in progress

The shipping `scripts/nomo` entry still uses the existing Python project controller. The opt-in `native_project` flow is the migration implementation, not a completed replacement.

## Current native path

`NativeCoding` registers real Etas `tool` declarations through `@tools`. Etas dispatches each tool body, calls its native Host boundary, and continues inference with the tool result. The native probe invokes the Etas binary directly; Python supplies only a local synthetic HTTP model, terminal transport and fixture setup/assertions.

| Tool | Parameters / return | Native authority | Approval |
|---|---|---|---|
| `git_status` | no arguments; `CommandOutput {exit_code, stdout, stderr}` | `Command.run<DefaultCommandSandbox>`; `/usr/bin/git` with region-bound cwd | Host command policy requires approval; execution blocked by upstream #62 |
| `git_diff` | `staged: bool`, `paths: Array<string>`; `CommandOutput` | Same native command boundary | Exact argv preview and Host approval; execution blocked by #62 |
| `git_log` | `count: i32`; `CommandOutput` | Same native command boundary | Same |
| `git_branches` | no arguments; `CommandOutput` | Same native command boundary | Same |
| `git_init` | no arguments; `CommandOutput` | Same native command boundary | Same |
| `git_branch`, `git_switch` | `name: string`; `CommandOutput` | Same native command boundary | Same |
| `git_commit` | `message: string`, `paths: Array<string>`; `CommandOutput` | Same native command boundary; optional staging then commit | Approval for each actual command; a denied commit does not undo completed staging; execution blocked by #62 |
| `read_file` | `pathname: string`; `FileContent {path, text}` | `Fs.read<ProjectRoot>` | Read allowed by native policy |
| `replace_file` | `change: {path, before, after}`; `FileOutcome {path, status}` | `Fs.read<ProjectRoot>`, `Fs.atomic_replace<ProjectRoot>`, Console and typed errors | Complete JSON preview, then approval at the actual Host write boundary |

The `ScopedReplace` trace spec limits file effects to reads and atomic replacement and forbids `Fs.write<ProjectRoot>`. The `nomo-native` runtime profile denies unlisted filesystem actions and requires native human approval for every atomic replacement. Runtime policy owns the pending request containing its path and bytes; it is not a source-level `Approval` parameter or a reusable application consent flag. Static trace selectors do not capture dynamic payloads. There is no compare-and-swap guarantee against an external writer changing the file while approval is pending.

## Evidence

- Official ETAS 0.12.0 graph and binary: `config/etas-latest-main.json`.
- Recorded compiler/source identities, native Host request order and actual model tool observations: `examples/native-project/file-roundtrip-20261111.json`.
- `python3 -B tests/native_project_probe.py --scenario files`: passed on 2026-11-11. Three local synthetic model requests: native read, native replacement, final answer. The terminal driver answered `yes` only after the complete synthetic preview matched exactly.
- `python3 -B tests/native_project_probe.py --scenario chat`: passed on 2026-11-11. Etas printed `nomo>`, ran the approved edit, accepted a second user request with the first request/answer in model context, displayed `/history`, and exited on `/quit`. Four local synthetic model requests; no Python conversation controller was involved.
- `examples/native-project/chat-roundtrip-20261111.json` records the latest native chat/tool catalogue run. All eight Git tool declarations are registered and compile, but their actual execution has not passed because of #62.
- Native trace records approval request `10000013` before `Fs.atomic_replace` request `12`; the write authority contains one approval. The edited file contains `before new\n`, and the next model request contains the actual `applied` tool result.
- `python3 -B tests/native_project_probe.py --scenario git`: not accepted yet. The model issued the native tool call, but the command Host failed before starting Git.
- Minimal reproduction and published upstream report: `examples/repros/command-root-cwd-0.12.0`, https://github.com/etas-project/etas-core/issues/62. No cwd substitution, Python dispatch or local Host/compiler patch is used.

## Remaining scope

1. Finish the native Git status round trip after #62 is fixed. Preserve the exact official compiler pin until an upstream fix is available.
2. Extend native approval and complete-operation previews to every mutation and command. Handle denial/interruption as product outcomes. Current proof covers one existing UTF-8 file replacement only.
3. Accept the eight implemented native Git tools after the cwd fix, and migrate navigation/search, file create/batch/delete/move/undo and terminal tools. The native Command API currently exposes synchronous `run`; retained PTY jobs, input/output handles and restart attachment still need a supported native substrate.
4. The native entry now owns `nomo>`, `/help`, `/history`, `/quit`, user input, continuous model/tool calls and in-process user/answer context. Remaining: the full product command surface and durable complete tool/message history. No arguments starts the native chat; one argument executes one request.
5. Move session selection, full history, recovery, summaries and budget records into Etas; migrate or import the existing host SQLite archive while preserving original data. This has not been implemented.
6. Move task lifecycle and recovery decisions into Etas. Python environment helpers must not retain the product state machine.
7. Switch the official entry only when the complete native product can run. Until then, retain the working current entry and document the prototype separately.
8. Accept continuous dialogue → read → approved edit → check → Git → exit → new-process restore, with actual execution evidence. This gate has not passed.

The migration is incomplete. A working native file tool does not establish complete native tool coverage, native session storage, terminal lifecycle or delivery readiness.
