module nomo.native.workspace;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};
import std.codec.text.{utf8_decode, Replace};
import std.io.{println, IOError};
import nomo.core.json.encode;
import nomo.native.history.{SessionContext, record, tool_finished};

public type ProjectRoot;
impl ProjectRoot ~ Region;

public type CommandOutput = { exit_code: i32, stdout: string, stderr: string };
type CommandPreview = { program: string, arguments: Array<string> };

flow text(value: bytes) -> string {
    return match utf8_decode(value, Replace) {
        Ok(decoded) => decoded,
        Err(_) => { abort("command output decoding failed"); }
    };
}

public flow execute(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let root = match path<ProjectRoot>(".") {
        Ok(value) => value,
        Err(_) => { abort("project root is unavailable"); }
    };
    let request = CommandPreview { program = program, arguments = arguments };
    let call = record("tool_call", "command", request, -1);
    let preview = match encode(request, "command preview conversion failed", "command preview encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    println("[COMMAND] " + preview);
    let result = run(with_cwd(command(program, arguments), root), DefaultCommandSandbox);
    let output = CommandOutput { exit_code = result.exit_code, stdout = text(result.stdout), stderr = text(result.stderr) };
    tool_finished("command", call, output);
    return output;
}
