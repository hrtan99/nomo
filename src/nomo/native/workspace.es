module nomo.native.workspace;

import std.fs.{Region, path};
import std.host.command.{command, with_cwd, run};
import std.codec.text.{utf8_decode, Replace};
import std.io.{println, IOError};
import nomo.core.json.encode;
import nomo.native.history.{SessionContext, record, observe_started};
import nomo.native.lifecycle.{begin, dispatching, returned, complete_attempt};

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

flow dispatch(program: string, arguments: Array<string>) -> CommandOutput {
    let root = match path<ProjectRoot>(".") {
        Ok(value) => value,
        Err(_) => { abort("project root is unavailable"); }
    };
    let request = CommandPreview { program = program, arguments = arguments };
    let preview = match encode(request, "command preview conversion failed", "command preview encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
    println("[COMMAND] " + preview);
    let result = run(with_cwd(command(program, arguments), root), DefaultCommandSandbox);
    let output = CommandOutput { exit_code = result.exit_code, stdout = text(result.stdout), stderr = text(result.stderr) };
    return output;
}

flow result_text(output: CommandOutput) -> string {
    return match encode(output, "command result conversion failed", "command result encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
}

public flow execute(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let call = record("tool_call", "command", CommandPreview { program = program, arguments = arguments }, -1);
    let session = perform SessionContext.current();
    let attempt = begin(session, "command", program, call, call);
    dispatching(attempt.id);
    let output = dispatch(program, arguments);
    returned(attempt.id, "tool", "command", result_text(output), call);
    complete_attempt(attempt.id);
    return output;
}

// Observations can inspect an interrupted operation without replacing its ticket.
// This does not change the Command Host's per-operation approval policy.
public flow execute_readonly(name: string, program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let call = observe_started(name, CommandPreview { program = program, arguments = arguments });
    let session = perform SessionContext.current();
    let attempt = begin(session, "observation", name, call, call);
    dispatching(attempt.id);
    let output = dispatch(program, arguments);
    returned(attempt.id, "tool", name, result_text(output), call);
    complete_attempt(attempt.id);
    return output;
}

// A journalled file transaction owns this operation. Keep its outer pending
// request intact instead of creating and completing another top-level tool.
public flow execute_step(program: string, arguments: Array<string>, parent: i64) -> CommandOutput
    ![SessionContext, Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let request = CommandPreview { program = program, arguments = arguments };
    record("operation", "command", request, parent);
    let output = dispatch(program, arguments);
    record("operation_result", "command", output, parent);
    return output;
}
