module nomo.application.commands.git;

import std.text.from_i32;
import nomo.domain.execution.git.GitRequest;
import nomo.domain.execution.command.CommandOutput;
import nomo.application.commands.requests.{execute as run, execute_readonly};

public flow execute(request: GitRequest) -> CommandOutput {
    return match request {
        GitRequest.Status => execute_readonly("git_status", "/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"]),
        GitRequest.Diff(staged, paths) => {
            var arguments = ["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv"];
            if staged { arguments = arguments.push("--cached"); }
            execute_readonly("git_diff", "/usr/bin/git", arguments.push("--").extend(paths))
        },
        GitRequest.Log(count) => execute_readonly("git_log", "/usr/bin/git", ["--no-optional-locks", "log", "--oneline", "-n", from_i32(count)]),
        GitRequest.Branches => execute_readonly("git_branches", "/usr/bin/git", ["--no-optional-locks", "branch", "--list"]),
        GitRequest.Init => run("/usr/bin/git", ["init", "--initial-branch=main"]),
        GitRequest.Branch(name) => run("/usr/bin/git", ["branch", "--", name]),
        GitRequest.Switch(name) => run("/usr/bin/git", ["switch", "--", name]),
        GitRequest.Commit(message, paths) => {
            if paths.len() > 0 {
                let staged = run("/usr/bin/git", ["add", "--"].extend(paths));
                if staged.exit_code != 0 { return staged; }
            }
            run("/usr/bin/git", ["commit", "-m", message])
        }
    };
}
