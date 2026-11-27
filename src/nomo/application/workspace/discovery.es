module nomo.application.workspace.discovery;

import nomo.application.commands.effects.CommandOperations;
import std.fs.{path, relative_name, WorkspacePath};
import std.text.from_i32;
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.execution.command.CommandOutput;
import nomo.application.commands.requests.execute_readonly;
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.configuration.context.SettingsContext;

flow location(pathname: string) -> WorkspacePath<ProjectRoot> {
    return match path<ProjectRoot>(pathname) {
        Ok(value) => value, Err(_) => abort("invalid project path"),
    };
}

flow discovery_arguments() -> Array<string> {
    return ["--hidden", "--no-require-git", "--color", "never"];
}

flow exclude_internal(arguments: Array<string>) -> Array<string> {
    let settings = perform SettingsContext.current();
    let selected = arguments.extend(settings.ignore.iter()
        .flat_map(pattern => ["--glob", "!" + pattern].iter()).collect());
    return selected.extend(["--glob", "!**/.git/**", "--glob", "!**/.nomo/**"]);
}

/// Discover files recursively with ripgrep's glob syntax and ignore rules. Empty glob uses normal ignore rules; an explicit glob has ripgrep's usual override precedence. depth=0 is unlimited. Exit 1 means no matches.
public flow find_files(pathname: string, glob: string, depth: i32) -> CommandOutput
    ![SessionContext.current, CommandOperations, SettingsContext.current, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    var arguments = discovery_arguments().push("--files").push("--sort").push("path");
    if glob != "" { arguments = arguments.push("--glob").push(glob); }
    if depth > 0 { arguments = arguments.push("--max-depth").push(from_i32(depth)); }
    arguments = exclude_internal(arguments).push("--").push(relative_name(location(pathname)));
    return execute_readonly("find_files", "/usr/bin/rg", arguments);
}

/// Search a file or directory recursively. regex=true uses ripgrep regular expressions; false searches literal text. Results include actual path and line numbers. Exit 1 means no matches; exit 2 reports an error.
public flow search_project(pathname: string, pattern: string, regex: bool) -> CommandOutput
    ![SessionContext.current, CommandOperations, SettingsContext.current, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>] {
    var arguments = discovery_arguments().push("--line-number").push("--with-filename").push("--no-heading").push("--sort").push("path");
    if !regex { arguments = arguments.push("--fixed-strings"); }
    arguments = exclude_internal(arguments).push("--").push(pattern).push(relative_name(location(pathname)));
    return execute_readonly("search_project", "/usr/bin/rg", arguments);
}
