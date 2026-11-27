# Nomo

Nomo is a project coding agent implemented in [Etas](https://github.com/etas-project/etas).
The default entry runs the Etas application: conversation selection, history,
context projection, model tools, reviewed edits, Git and process operations are
owned by Etas modules. `scripts/nomo-native` is an alias for the same entry.

## Start a project

Use the existing Docker image and installed official **Etas 0.24.13 / std 0.9.0**.
Set `MINIMAX_API_KEY` in your shell, then open an existing project directory:

```sh
mkdir -p ~/Projects/nomo-test
./scripts/nomo ~/Projects/nomo-test
./scripts/nomo --open                 # recent-project chooser
./scripts/nomo --sessions --all       # saved conversations
./scripts/nomo ~/Projects/nomo-test --resume
./scripts/nomo ~/Projects/nomo-test --id native-0 --history
./scripts/nomo --help
```

For example, enter:

> 在这个项目中新建 index.html，制作一个鹈鹕骑自行车的响应式网页。HTML、CSS、JS 放在同一个文件，使用内联 SVG，车轮和脚踏板运动，有暂停/继续按钮，不使用外部依赖。完成后做必要检查。

Review the displayed changes or commands and answer the approval prompts.
`/undo` restores an applied batch. `/help` lists current commands.

## Conversations and tools

Project selection: `/open [FOLDER]`, `/projects`, `/new [TITLE]`, `/sessions [all]`,
`/resume [ID]`. Files: `/tree [PATH]`, `/glob PATTERN`, `/search REGEX`, `/read FILE`.
The model can also create/edit files and apply multi-file batches after approval.

History: `/history [TEXT]`, `/page EVENT`, `/rename TITLE`, `/fork [EVENT]`,
`/export FILE`, `/import FILE`. Complete history remains in SQLite; `/compact`
creates a separate model-context summary. `/runs` lists recorded operations;
`/resolve-run ID NOTE` explicitly records resolution of an unknown result.

Commands use JSON arrays, preserving argument boundaries:

```text
/exec ["/usr/bin/git", "status", "--short"]
/spawn ["/bin/sh", "-c", "printf 'ready\n'; read reply; printf '%s\n' \"$reply\""]
/jobs
/poll JOB_ID 65536
/send JOB_ID "hello\n"
/close-input JOB_ID
/stop JOB_ID
/job-output JOB_ID
```

Git: `/git status`, `/git diff`, `/git log`, `/git branches`, `/git init`,
`/git branch NAME`, `/git switch NAME`. `/help` documents commit arguments.
Native command execution currently uses pipes; the upstream process API has no PTY.

Ctrl+P then Ctrl+Q detaches the terminal while the project's Etas Host stays
running. Run the same project command without startup options to reconnect.
`/open FOLDER` retains the previous project's Host; `/quit` shuts down the current
Host. Reopening a fresh Host restores recorded process facts, but cannot reconnect
the old Host's live process handles. Continuous automatic background-output
capture remains blocked by an upstream compiler issue.

## Configuration and saved state

Root and nested `AGENTS.md` files supply scoped project instructions. Optional
`.nomo.toml`:

```toml
[project]
context_window = 1000000
max_output_tokens = 131072
compact_ratio = 0.75
keep_messages = 12
command_timeout = 600
ignore = ["generated/**"]
instructions = ["Keep changes focused and use the existing project style."]
check = ["python3", "-m", "unittest"]
```

`/config` shows selected settings; `/check` runs the configured command. Context
compaction runs before model inference; compaction within an active tool loop is
not implemented. Independent cumulative/context/provider-output token controls
remain an [upstream limitation](https://github.com/etas-project/etas-interpreter/issues/125).
A configured context window does not establish actual 1M-token capacity.

Native state defaults to `~/.local/state/nomo/native/conversations.sqlite3`.
`NOMO_NATIVE_STATE` selects an exact native state directory. `NOMO_STATE_DIR`
selects its parent (`$NOMO_STATE_DIR/native`); `XDG_STATE_HOME` is also supported.
`NOMO_NATIVE_TRACE_ROOT` selects the trace directory. Existing Python project
SQLite files and bounded-session files remain untouched; the new entry does not
open or silently convert those formats.

Use the explicit migration command for an old project database:

```sh
./scripts/nomo-migrate-native --from project /absolute/old/project.sqlite3 /absolute/new-directory
# After migration reports completion:
NOMO_NATIVE_STATE=/absolute/new-directory/state ./scripts/nomo /absolute/project
```

The migration preserves source backups and historical facts. Bounded legacy
sessions still require the historical inspection tools; their complete native
migration is unfinished. See [migration evidence and remaining work](NATIVE_MIGRATION.md).
The default switch does not mean all thirteen architecture tasks are accepted.

## Development

Docker with Compose, Git and Python 3.11+ are needed for the local Docker-terminal
transport, compiler tooling, tests and one-time SQLite migration. Python no longer
runs the product's model, conversation, tool, file-edit or Git controller. Historical
format producers used only by migration probes live in
[tests/fixtures/legacy_project](tests/fixtures/legacy_project/README.md).

```sh
./scripts/container-build.sh
./scripts/etas-02413-official-container.sh prepare
./scripts/etas-02413-official-container.sh build
./scripts/etas-02413-official-container.sh verify
python3 -B scripts/check-architecture.py
python3 -B tests/native_worker_probe.py
```

Runtime credentials, saved databases and generated evidence are excluded from releases.
