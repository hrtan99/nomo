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

## Native conversations and context

`ConversationStore` / `NativeHistory` use the Etas Memory Host with SQLite at `/native-state/conversations.sqlite3`. Etas owns session creation, selection, listing, renaming, user/assistant messages, tool requests/results, summaries and the ledger. A source `SessionContext` effect binds tool logging to the selected conversation; the entry handles it inside the model call. There is no Python conversation or SQLite adapter in this path.

Events are append-only records with separate content chunks. The 65,536-scalar chunk width keeps individual Memory values below the upstream storage limit; it is not a task, message or conversation length limit. Large-event acceptance is blocked by the native string-slice continuation hang reported in etas-interpreter#101; no slicing workaround is used. Event indexes are reserved before publication. An interrupted archive write appears as an explicit incomplete record, and a tool is not dispatched until its request record is saved. Pending requests survive process exit and are shown on startup; complete interruption/recovery handling remains a separate unfinished gate.

`RollingContext` keeps the original request, a model-generated summary and recent original events. After summarization, the recent suffix has at most 12 events and 393,216 text bytes; larger events remain in the archive and are represented by the summary. This recent-suffix change has not passed large-event acceptance because of #101. The automatic trigger uses a text estimate of three UTF-8 bytes per token at 75% of the configured 1,048,576-token window. `/compact` uses the native summary agent; it never deletes original events. The ledger records attempted agent turns, tool requests, compactions, configured generation allowances and estimated context bytes. These counters are not measured provider token usage or billing.

The native entry requires `--workspace PATH` identifying the folder mounted at `/project`. It resumes the last selected native conversation for that folder. Optional `--new`, `--resume ID` and `--once REQUEST` select startup behavior. Interactive commands include `/new [TITLE]`, `/sessions`, `/resume ID`, `/rename TITLE`, `/history`, `/compact`, `/status`, `/export FILE`, `/import FILE` and `/quit`. The native Compose overlay also requires an existing `NOMO_NATIVE_STATE` directory, alongside the workspace and evidence directories.

For existing Python-era `project.sqlite3` history, use the previous Nomo entry's `/export FILE` to produce `nomo-conversation-1` JSON, then import that file from inside the selected project with the native `/import FILE`. Etas reads the old format directly, copies its messages into a new native conversation and retains the exact original export text as an archive record. The old JSON and SQLite database are not modified. Source IDs, metadata, timestamps and earlier usage remain available in the retained source package. Native imports receive new local event IDs and fresh native-run ledger counters; historical requests and approvals are data, not active permissions.

`/export FILE` writes a `nomo-native-conversation-1` snapshot to a project-relative path after a complete export preview and native Host approval. Both export and import use Etas filesystem/JSON APIs. Import is currently not atomic across its individual archive writes; interrupted import recovery is not yet accepted. The transfer probe uses the old Python store only to generate an authentic old-format fixture, not to implement the native transfer path.

## Evidence

- Official ETAS 0.12.0 graph and binary: `config/etas-latest-main.json`.
- Recorded compiler/source identities, native Host request order and actual model tool observations: `examples/native-project/file-roundtrip-20261111.json`.
- `python3 -B tests/native_project_probe.py --scenario files`: passed on 2026-11-11. Three local synthetic model requests: native read, native replacement, final answer. The terminal driver answered `yes` only after the complete synthetic preview matched exactly.
- `python3 -B tests/native_project_probe.py --scenario chat`: passed on 2026-11-11. Etas printed `nomo>`, ran the approved edit, accepted a second user request with the first request/answer in model context, displayed `/history`, and exited on `/quit`. Four local synthetic model requests; no Python conversation controller was involved.
- `examples/native-project/chat-roundtrip-20261111.json` records the latest native chat/tool catalogue run. All eight Git tool declarations are registered and compile, but their actual execution has not passed because of #62.
- `python3 -B tests/native_project_probe.py --scenario persist`: native read/approved edit, durable complete tool history, native model summary, exit and a new Etas process restoring the same conversation passed. Five local synthetic model requests. Model-free native create/list/rename/select and persisted ledger checks also passed.
- `python3 -B tests/native_project_probe.py --scenario transfer`: old-format import, reviewed native export and native reimport passed with zero model requests; the old SQLite and JSON bytes stayed unchanged.
- `examples/native-project/persistence-20261111.json` preserves trace hashes, observed restored model context, ledger and transfer results. The positive `auto` scenario imported a synthetic 2,400,000-byte message but hung in native slicing before any model request. It was interrupted; automatic large-context compaction is not accepted. A dependency-free positive reproduction prints `SLICE_START` but never `SLICE_BYTES 70001` before a 30-second external deadline: `examples/repros/char-slice-resume-0.12.0`, https://github.com/etas-project/etas-interpreter/issues/101.
- Native trace records approval request `10000013` before `Fs.atomic_replace` request `12`; the write authority contains one approval. The edited file contains `before new\n`, and the next model request contains the actual `applied` tool result.
- `python3 -B tests/native_project_probe.py --scenario git`: not accepted yet. The model issued the native tool call, but the command Host failed before starting Git.
- Minimal reproduction and published upstream report: `examples/repros/command-root-cwd-0.12.0`, https://github.com/etas-project/etas-core/issues/62. No cwd substitution, Python dispatch or local Host/compiler patch is used.

## Remaining scope

1. Finish the native Git status round trip after #62 is fixed. Preserve the exact official compiler pin until an upstream fix is available.
2. Extend native approval and complete-operation previews to every mutation and command. Handle denial/interruption as product outcomes. Current proof covers one existing UTF-8 file replacement only.
3. Accept the eight implemented native Git tools after the cwd fix, and migrate navigation/search, file create/batch/delete/move/undo and terminal tools. The native Command API currently exposes synchronous `run`; retained PTY jobs, input/output handles and restart attachment still need a supported native substrate.
4. The native entry owns `nomo>`, user input, continuous model/tool calls and the conversation commands listed above. Remaining: the full product command surface, project switching/recent-project selection and tool shortcuts.
5. Native persistence, selection, normal new-process restore, manual summaries, ledger records and old-format transfer are implemented and accepted as described above. Remaining: automatic-threshold/large-context capacity acceptance after etas-interpreter#101, history search/fork/paging, project instructions/configuration, and complete interrupted-operation recovery. Provider usage is not currently exposed to this source ledger.
6. Finish task lifecycle, interruption and recovery decisions in Etas, including unfinished tools, imports/exports and multi-file operations. Python environment helpers must not retain the product state machine.
7. Switch the official entry only when the complete native product can run. Until then, retain the working current entry and document the prototype separately.
8. Accept continuous dialogue → read → approved edit → check → Git → exit → new-process restore, with actual execution evidence. This gate has not passed.

The migration is incomplete. The accepted native conversation/file flows do not establish complete tool coverage, interruption/terminal lifecycle, automatic large-context handling or delivery readiness.
