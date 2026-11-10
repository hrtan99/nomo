## Observed on the official ETAS 0.12.0 dependency graph

- CLI `fe3de961aa2f1c55ec2ab5fc31383ea1d3e16af9`
- core `3fc5b68bc886c952559003375590ccd0f95a53cb`
- frontend `c70b4802768393ed7310a33c4e38a8b8fb2e9692`
- interpreter `4f5eae3702605f8630c682d54689167c2dea8394`
- Ubuntu 26.04, Linux/aarch64, unprivileged Docker user.

`path<ProjectRoot>(".")` succeeds, but passing that region root to `with_cwd` causes `Command.run` to fail before starting the process. The standalone reproduction below needs no model or application code.

## Minimal reproduction

`etas.toml`:
```toml
[package]
name = "command-root-cwd"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "command"
[runtime.profiles.command.filesystem.regions."app.main.ProjectRoot"]
root = "/tmp"
read = true
write = false
[runtime.profiles.command.command]
allow = ["/bin/pwd"]
isolation = "trusted-unconfined"
[runtime.profiles.command.policy]
mode = "local-static"
rules = ["command=allow", "console=allow"]
[[bin]]
name = "command-root-cwd"
module = "app.main"
flow = "main"
```

`src/app/main.es`:
```etas
module app.main;
import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};
type ProjectRoot;
impl ProjectRoot ~ Region;
flow main(args: Array<string>) -> i32 ![Command.run<DefaultCommandSandbox>] {
    let root = match path<ProjectRoot>(".") {
        Ok(value) => value,
        Err(_) => { abort("root path construction failed"); }
    };
    let result = run(with_cwd(command("/bin/pwd", []), root), DefaultCommandSandbox);
    return result.exit_code;
}
```

Run `etas pkg lock .` and `etas run . --allow-effects`.

## Expected

`/bin/pwd` executes in the configured `/tmp` region root and the flow returns zero.

## Actual

Exit status 3:
```text
error[analysis::UnhandledRuntimeError]: command host boundary failed: workspace path must not be empty
  | let result = run(with_cwd(command("/bin/pwd", []), root), DefaultCommandSandbox);
run value: null
events: 4, checkpoints: 0
```

## Likely cause

In `crates/etas_host/src/command/local.rs`, `execute_local` binds `request.cwd` through `self.regions.bind(path)`. `WorkspaceRegionRegistry::bind` uses file-oriented `normalize_relative`, which rejects `.` after removing CurDir components. The existing `bind_directory` uses `normalize_directory_relative` and preserves the region root `.`. `WorkspacePathRef::new` also accepts it. This looks like the directory binding path is missing specifically at the command cwd boundary.

## Impact / acceptance

Blocks executing commands, including native Git tools, at a project's configured workspace root. Please preserve the descriptor-bound cwd and workspace authority guarantees while making a valid root cwd executable. Acceptance should include a checked Etas source/CLI run with `with_cwd(command(...), path<R>("."))`, not only a Rust-side child-directory test.

Duplicate searches for `with_cwd` and `cwd root` found #5 and #13 but no report of this root-directory binding failure. No workaround or compiler/Host patch has been applied in the consumer.
