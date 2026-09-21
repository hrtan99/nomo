module app.main;

import std.fs.{IOError, Region, WorkspacePath, path, read_bytes};
import std.effects.Fs;
import std.host.command.{command, run, with_env, with_stdin};
import std.runtime.checkpoint;
import std.runtime.error.IndexError;
import std.io.println;

type ProjectRoot;
impl ProjectRoot ~ Region;

flow main(args: Array<string>) -> i32
    ![Fs.read<ProjectRoot>, Error<IOError>, Error<IndexError>, Command.run<DefaultCommandSandbox>]
{
    let candidate: Result<WorkspacePath<ProjectRoot>, IOError> = path<ProjectRoot>("input.txt");
    let target = match candidate {
        Ok(value) => value,
        Err(_) => abort("invalid workspace path"),
    };
    let input = read_bytes(target);
    let env: Map<string, string> = { "ETAS010_ENV" => "explicit" };
    let cmd = command("/bin/sh", ["-c", "IFS= read -r line; printf '%s|%s|%s' \"$1\" \"$ETAS010_ENV\" \"$line\"; printf '%s|%s' \"${HOME-unset}\" \"${NOMO_GATEWAY_CLIENT_TOKEN-unset}\" >&2; printf spawned > \"$2\"; exit 7", "etas010", "argument with spaces", args[0]]);
    let result = run(with_stdin(with_env(cmd, env), input), DefaultCommandSandbox);
    checkpoint("command-completed");
    return 0;
}

flow repeated(args: Array<string>) -> i32 {
    println("SAME");
    checkpoint("before-loop");
    println("SAME");
    for item in [1, 2] limit Iterations(2) {
        println("SAME");
        checkpoint("loop");
    }
    return 0;
}
