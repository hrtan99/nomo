module nomo.native.git;

import nomo.native.workspace.{CommandOutput, execute, execute_readonly};
import std.text.{from_i32, trim, split_once, strip_prefix, parse_i32};
import std.json.parse;
import std.agent.message.Message;
import std.collections.len;
import std.io.IOError;
import nomo.native.history.SessionContext;

/// Read the current project's Git branch and working tree status.
public tool git_status() -> CommandOutput ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute_readonly("git_status", "/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"]);
}

/// Read the working-tree or staged diff, optionally restricted to exact paths.
public tool git_diff(staged: bool, paths: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    var arguments = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv"];
    if staged { arguments = arguments.push("--cached"); }
    arguments = arguments.push("--");
    for pathname in paths limit Iterations(2147483647) { arguments = arguments.push(pathname); }
    return execute_readonly("git_diff", "/usr/bin/git", arguments);
}

/// Read the most recent count commits.
public tool git_log(count: i32) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute_readonly("git_log", "/usr/bin/git", ["--no-optional-locks", "log", "--oneline", "-n", from_i32(count)]);
}

/// List local branches.
public tool git_branches() -> CommandOutput ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute_readonly("git_branches", "/usr/bin/git", ["--no-optional-locks", "branch", "--list"]);
}

/// Initialize this project as a Git repository after native Host approval.
public tool git_init() -> CommandOutput ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute("/usr/bin/git", ["init", "--initial-branch=main"]);
}

/// Create a local branch after native Host approval.
public tool git_branch(name: string) -> CommandOutput ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute("/usr/bin/git", ["branch", "--", name]);
}

/// Switch to an existing branch after native Host approval.
public tool git_switch(name: string) -> CommandOutput ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    return execute("/usr/bin/git", ["switch", "--", name]);
}

/// Stage selected paths, then commit. Each command receives its own Host approval.
public tool git_commit(message: string, paths: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    if len(paths) > 0 {
        var arguments = ["add", "--"];
        for pathname in paths limit Iterations(2147483647) { arguments = arguments.push(pathname); }
        let staged = execute("/usr/bin/git", arguments);
        if staged.exit_code != 0 { return staged; }
    }
    return execute("/usr/bin/git", ["commit", "-m", message]);
}

type CommitRequest = { message: string, paths: Array<string> };

flow json_paths(raw: string) -> Array<string> {
    if trim(raw) == "" { return []; }
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { abort("provide paths as a JSON string array"); } };
    let converted: Option<Message<Array<string>>> = Message.new(parsed).cast<Array<string>>();
    return match converted { Some(value) => value.body, None() => { abort("paths must be a JSON string array"); } };
}

/// The native command UI delegates to the same tools and approvals as the model.
public flow shortcut(raw: string) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let (operation, rest) = match split_once(trim(raw), " ") { Some(parts) => parts, None() => (trim(raw), "") };
    let argument = trim(rest);
    if operation == "status" { return git_status(); }
    if operation == "branches" { return git_branches(); }
    if operation == "init" { return git_init(); }
    if operation == "branch" { return git_branch(argument); }
    if operation == "switch" { return git_switch(argument); }
    if operation == "log" {
        let count = if argument == "" { 20 } else { match parse_i32(argument) { Ok(value) => value, Err(_) => { abort("expected a Git log count"); } } };
        return git_log(count);
    }
    if operation == "diff" {
        var staged = false;
        var selected = argument;
        if argument == "--staged" { staged = true; selected = ""; }
        else { match strip_prefix(argument, "--staged ") { Some(value) => { staged = true; selected = value; } None() => {} } }
        return git_diff(staged, json_paths(selected));
    }
    if operation == "commit" {
        let parsed = match parse(argument) { Ok(value) => value, Err(_) => { abort("use /git commit with JSON containing message and paths"); } };
        let converted: Option<Message<CommitRequest>> = Message.new(parsed).cast<CommitRequest>();
        let request = match converted { Some(value) => value.body, None() => { abort("commit JSON requires message:string and paths:Array<string>"); } };
        return git_commit(request.message, request.paths);
    }
    abort("Git command: status, diff [--staged] [JSON_PATHS], log [COUNT], branches, init, branch NAME, switch NAME, commit JSON");
}
