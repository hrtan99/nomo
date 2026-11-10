module nomo.native.workspace;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};
import std.codec.text.{utf8_decode, Replace};
import std.io.{println, IOError};
import nomo.core.json.encode;

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
    ![Command.run<DefaultCommandSandbox>, Console, Error<IOError>] {
    let root = match path<ProjectRoot>(".") {
        Ok(value) => value,
        Err(_) => { abort("project root is unavailable"); }
    };
    let preview = match encode(CommandPreview { program = program, arguments = arguments }, "command preview conversion failed", "command preview encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    println("[COMMAND] " + preview);
    let result = run(with_cwd(command(program, arguments), root), DefaultCommandSandbox);
    return CommandOutput { exit_code = result.exit_code, stdout = text(result.stdout), stderr = text(result.stderr) };
}
