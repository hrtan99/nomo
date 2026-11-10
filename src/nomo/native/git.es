module nomo.native.git;

import nomo.native.workspace.{CommandOutput, execute};
import std.text.from_i32;
import std.collections.len;
import std.io.IOError;

/// Read the current project's Git branch and working tree status.
public tool git_status() -> CommandOutput ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"]);
}

/// Read the working-tree or staged diff, optionally restricted to exact paths.
public tool git_diff(staged: bool, paths: Array<string>) -> CommandOutput
    ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    var arguments = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv"];
    if staged { arguments = arguments.push("--cached"); }
    arguments = arguments.push("--");
    for pathname in paths limit Iterations(2147483647) { arguments = arguments.push(pathname); }
    return execute("/usr/bin/git", arguments);
}

/// Read the most recent count commits.
public tool git_log(count: i32) -> CommandOutput
    ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["--no-optional-locks", "log", "--oneline", "-n", from_i32(count)]);
}

/// List local branches.
public tool git_branches() -> CommandOutput ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["--no-optional-locks", "branch", "--list"]);
}

/// Initialize this project as a Git repository after native Host approval.
public tool git_init() -> CommandOutput ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["init", "--initial-branch=main"]);
}

/// Create a local branch after native Host approval.
public tool git_branch(name: string) -> CommandOutput ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["branch", "--", name]);
}

/// Switch to an existing branch after native Host approval.
public tool git_switch(name: string) -> CommandOutput ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    return execute("/usr/bin/git", ["switch", "--", name]);
}

/// Stage selected paths, then commit. Each command receives its own Host approval.
public tool git_commit(message: string, paths: Array<string>) -> CommandOutput
    ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    if len(paths) > 0 {
        var arguments = ["add", "--"];
        for pathname in paths limit Iterations(2147483647) { arguments = arguments.push(pathname); }
        let staged = execute("/usr/bin/git", arguments);
        if staged.exit_code != 0 { return staged; }
    }
    return execute("/usr/bin/git", ["commit", "-m", message]);
}
