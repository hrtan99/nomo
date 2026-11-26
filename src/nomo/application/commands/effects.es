module nomo.application.commands.effects;

import nomo.domain.execution.command.{CommandRequest, CommandOutput, CommandObservation, CommandMode};

public effect CommandOperations {
    action execute(session: string, mode: CommandMode, request: CommandRequest) -> CommandObservation;
    action step(session: string, request: CommandRequest, parent: i64) -> CommandOutput;
}
