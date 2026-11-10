# Command root cwd failure

Confirmed with official ETAS 0.12.0 on 2026-11-11. The exact compiler graph is in `UPSTREAM_ISSUE.md`.

```sh
etas run . --allow-effects
```

The checked source constructs `path<ProjectRoot>(".")`, passes it to `with_cwd`, and requests `/bin/pwd`. The region root is `/tmp`.

Observed exit status: **3**. The command does not start:

```text
error[analysis::UnhandledRuntimeError]: command host boundary failed: workspace path must not be empty
 --> src/app/main.es:14:18
  | let result = run(with_cwd(command("/bin/pwd", []), root), DefaultCommandSandbox);
run value: null
events: 4, checkpoints: 0
```

The Nomo native tool integration reaches the same Host failure after the model's `git_status` call. Its positive round-trip probe remains failing until upstream fixes cwd root binding. The application does not replace this operation with Python or bypass the checked cwd.

Upstream report: https://github.com/etas-project/etas-core/issues/62. The published payload is preserved in `UPSTREAM_ISSUE.md`.
