module nomo.application.commands.requests;

import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.execution.command.{CommandRequest, CommandOutput, CommandObservation, CommandMode};
import nomo.application.commands.effects.CommandOperations;

flow execute_request(mode: CommandMode, request: CommandRequest) -> CommandObservation
    ![SessionContext, CommandOperations] {
    return perform CommandOperations.execute(perform SessionContext.current(), mode, request);
}

public flow execute(program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, CommandOperations] {
    return execute_request(CommandMode.Mutating, CommandRequest { program, arguments, stdin = None() }).output;
}

public flow execute_input(program: string, arguments: Array<string>, input: string) -> CommandOutput
    ![SessionContext, CommandOperations] {
    return execute_request(CommandMode.Mutating, CommandRequest { program, arguments, stdin = Some(input) }).output;
}

public flow execute_readonly(name: string, program: string, arguments: Array<string>) -> CommandOutput
    ![SessionContext, CommandOperations] {
    return execute_request(CommandMode.Observation(name), CommandRequest { program, arguments, stdin = None() }).output;
}

public flow execute_readonly_input(name: string, program: string, arguments: Array<string>, input: string) -> CommandObservation
    ![SessionContext, CommandOperations] {
    return execute_request(CommandMode.Observation(name), CommandRequest { program, arguments, stdin = Some(input) });
}

public flow execute_step(program: string, arguments: Array<string>, parent: i64) -> CommandOutput
    ![SessionContext, CommandOperations] {
    return perform CommandOperations.step(perform SessionContext.current(),
        CommandRequest { program, arguments, stdin = None() }, parent);
}
