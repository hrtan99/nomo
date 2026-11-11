# Nomo

Nomo is a local project coding agent built with [ETAS](https://github.com/etas-project/etas). The current project entry supports folder projects, file and terminal tools, reviewed multi-file changes, complete saved conversations, and automatic model-context summaries. Etas `spec` interfaces define the model, tool catalogue and context policy; host adapters implement filesystem, PTY processes, SQLite and terminal interaction.

## Get started

Use the existing Docker image, pinned ETAS 0.13.1 installation and `MINIMAX_API_KEY` configuration. Open any existing project folder, including an empty one:

```sh
./scripts/nomo --root ~/Projects/nomo-test
# Or cd into the project and run /absolute/path/to/nomo/scripts/nomo.
./scripts/nomo --open                  # choose a recent project or type a path
./scripts/nomo --sessions --all        # list saved conversations
./scripts/nomo --resume               # choose a conversation for this project
./scripts/nomo --root ~/Projects/nomo-test --latest
```

For example, enter: `在这个项目中新建 index.html，制作一个鹈鹕骑自行车的响应式网页。HTML、CSS、JS 放在同一个文件，使用内联 SVG，车轮和脚踏板运动，有暂停/继续按钮，不使用外部依赖。完成后做必要检查。` The agent can create the file directly. Review the file diff or command and answer `yes` to apply it. Related file edits can share one batch preview and approval; `/undo` restores the latest batch.

Project commands: `/open [FOLDER]`, `/projects`, `/new`, `/sessions [all]`, `/resume [ID]`. Navigation: `/tree`, `/glob PATTERN`, `/read FILE [FIRST LAST]`, `/search TEXT`, `/regex PATTERN`. Discovery honors nested `.gitignore` files and project ignore patterns. Agent tools also include create/write/edit, mkdir, delete, move/rename and multi-file batches.

History commands: `/history [SEARCH TEXT]`, `/rename TITLE`, `/fork [EVENT_ID]`, `/export FILE`, `/import FILE [PROJECT]`. `/history` uses a pager when available; it reads the full archive, not the shortened model context. Default state is `~/.local/state/nomo`; `NOMO_STATE_DIR` selects another directory. Project conversations are stored in `project.sqlite3`. Earlier workspace-bound sessions are listed too and their saved timelines are copied into the new archive when selected; their original records remain intact. Earlier output excerpts retain the limitations of their recorded format. `--legacy` runs the earlier bounded terminal workflow. Explicit legacy `--allow`/`--page` arguments also select that workflow.

Terminal commands: `/exec ARGV...`, `/spawn ARGV...`, `/jobs`, `/poll JOB [OFFSET]`, `/send JOB TEXT`, `/stop JOB`. Commands run locally in the project with a PTY and the current user's permissions. Background/interactive jobs and their complete output logs survive leaving Nomo. `/poll` returns an offset for reading later output; `/send` submits a line of input. Shell pipelines require an explicit shell, for example `/exec /bin/sh -c 'python3 -m http.server 8000'`. Use `/spawn` for servers. Network access follows the local environment.

Git commands: `/git status`, `/git diff [FILES...]`, `/git log`, `/git branches`, `/git init`, `/git branch NAME`, `/git switch NAME`, `/git commit "MESSAGE" [FILES...]`. The agent has corresponding Git tools; repository changes require a reviewed proposal. Nomo does not automatically commit just because it edited files.

Context is summarized automatically before its estimated size approaches the configured model window. The original request, latest request, scoped project instructions and recent messages accompany the summary. All original events remain in SQLite and exports; summaries are a separate model projection. `/compact` summarizes manually, and `/status` shows context estimates and the latest measured provider usage when available. Token admission uses a conservative text estimate calibrated with observed provider input usage; it is not an exact tokenizer. New project conversations have no fixed 48-turn or three-file continuation cap.

Root and nested `AGENTS.md` files are loaded automatically with their directory scope. Optional `.nomo.toml` configuration:

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

`command_timeout` is how long `/exec` waits before returning a retained job, rather than killing it. The current native model supports up to 131072 output tokens per action and a 1048576-token total context envelope. Provider limits still apply. `--once QUESTION` runs one task; noninteractive file/command proposals are retained for review instead of being implicitly approved. `./scripts/nomo --help` and `/help` list the current commands.

## Installation and checks

Python 3.11+, Docker with Compose, and Git are required. For a fresh local toolchain:

```sh
./scripts/container-build.sh
./scripts/etas-0131-official-container.sh prepare
./scripts/etas-0131-official-container.sh build
./scripts/etas-0131-official-container.sh verify
```

Set `MINIMAX_API_KEY` in your shell before starting a model-backed task. The pinned toolchain identity is recorded in `config/etas-latest-main.json`.

ETAS 0.12.0 no longer accepts native `storage` limit overrides. The earlier `--legacy` workflows use upstream native storage defaults (1 MiB per value, 4 MiB per result); the current project workflow stores its conversation history in host SQLite and is unaffected. Use the earlier Nomo revision with ETAS 0.4.1 for legacy workflows requiring the enlarged native storage limits.

Focused offline checks:

```sh
python3 -m unittest discover -s tests -p test_project_workflow.py
python3 -m unittest discover -s tests -p test_nomo_terminal.py
python3 -B tests/project_native_probe.py
```

The native probe uses a local synthetic model server. `tests/real_project_workflow_probe.py --credential-file /absolute/path/to/private-key-file` runs the corresponding real MiniMax workflow in a disposable synthetic project. Browser acceptance optionally uses Playwright and a local Chrome installation.

Runtime credentials, conversation databases, generated evidence, local management documents and bytecode caches are not part of the release.

The complete Etas native migration is in progress. Use `./scripts/nomo-native /absolute/project/path` to try the opt-in native entry with the installed toolchain and `MINIMAX_API_KEY`; `./scripts/nomo-native --open` uses its native recent-project chooser. Ctrl+P then Ctrl+Q detaches its terminal while Etas and live jobs keep running; run the same project command without startup options to reconnect. `/quit` shuts down the execution endpoint. [Native migration status and launch instructions](NATIVE_MIGRATION.md) record implemented tools, actual Host/approval evidence, upstream dependencies and remaining delivery gates; the default entry has not switched yet.
