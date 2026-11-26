module nomo.adapters.process.foreground;

import std.fs.path;
import std.host.command.{Command as HostCommand, run as run_native};
import std.codec.text.{utf8_decode, utf8_encode, Replace};
import std.io.IOError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.execution.command.{CommandRequest, CommandOutput};
import nomo.application.commands.ports.CommandRunner;

public type HostCommandRunner = {};

flow text(value: bytes) -> string {
    return match utf8_decode(value, Replace) {
        Ok(decoded) => decoded,
        Err(_) => abort("command output decoding failed"),
    };
}

impl HostCommandRunner ~ CommandRunner {
    flow run(self, request: CommandRequest) -> CommandOutput ![Command.run<DefaultCommandSandbox>, Error<IOError>] {
        let root = match path<ProjectRoot>(".") {
            Ok(value) => value,
            Err(_) => abort("project root is unavailable"),
        };
        var selected = HostCommand.new(request.program, request.arguments).with_cwd(root);
        match request.stdin { Some(value) => { selected = selected.with_stdin(utf8_encode(value)); } None() => (), }
        let result = run_native(selected, DefaultCommandSandbox);
        return CommandOutput { exit_code = result.exit_code, stdout = text(result.stdout), stderr = text(result.stderr) };
    }
}
