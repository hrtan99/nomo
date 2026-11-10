module nomo.native.git;

import nomo.native.workspace.{CommandOutput, execute};

/// Read the current project's Git branch and working tree status.
public tool git_status() -> CommandOutput ![Command.run<DefaultCommandSandbox>] {
    return execute("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"]);
}
