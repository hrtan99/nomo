module nomo.application.commands.encoding;

import nomo.domain.serialization.json.encode;
import nomo.domain.execution.command.{CommandRequest, CommandPreview, CommandInput, CommandOutput};

public flow request_text(request: CommandRequest) -> string {
    let result = match request.stdin {
        Some(value) => encode(CommandInput { program = request.program, arguments = request.arguments, stdin = value }, "history conversion failed", "history encoding failed"),
        None() => encode(CommandPreview { program = request.program, arguments = request.arguments }, "history conversion failed", "history encoding failed")
    };
    return match result { Ok(value) => value, Err(error) => { abort(error); } };
}

public flow preview_text(request: CommandRequest) -> string {
    let result = match request.stdin {
        Some(value) => encode(CommandInput { program = request.program, arguments = request.arguments, stdin = value }, "command input conversion failed", "command input encoding failed"),
        None() => encode(CommandPreview { program = request.program, arguments = request.arguments }, "command preview conversion failed", "command preview encoding failed")
    };
    return match result { Ok(value) => value, Err(error) => { abort(error); } };
}

public flow result_text(output: CommandOutput) -> string {
    return match encode(output, "command result conversion failed", "command result encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
}

public flow step_result(output: CommandOutput) -> string {
    return match encode(output, "history conversion failed", "history encoding failed") {
        Ok(value) => value, Err(error) => { abort(error); }
    };
}
