module nomo.application.commands.service;

import std.io.IOError;
import nomo.domain.execution.command.{CommandRequest, CommandOutput, CommandObservation, CommandMode, journal};
import nomo.application.commands.ports.{CommandRunner, CommandPreviewSink};
import nomo.application.commands.encoding.{request_text, result_text, step_result};
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.execution.service.{begin, dispatching, returned, complete_attempt};

public flow run<R ~ CommandRunner, V ~ CommandPreviewSink, A ~ AttemptRepository, P ~ ResultPublication, C ~ ConversationReader, W ~ ConversationWriter>(runner: R, preview: V, repository: A, publication: P, history: C, writer: W, session: string, mode: CommandMode, request: CommandRequest) -> CommandObservation
    ![Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    let entry = journal(mode, request.program);
    let call = writer.append(session, entry.role, entry.name, request_text(request), -1);
    let attempt = begin(repository, session, entry.kind, entry.label, call, call);
    dispatching(repository, attempt.id);
    preview.show(request);
    let output = runner.run(request);
    let index = returned(repository, publication, attempt.id, "tool", entry.name, result_text(output), call);
    complete_attempt(repository, publication, history, attempt.id);
    return CommandObservation { result_event = index, output };
}

public flow step<R ~ CommandRunner, V ~ CommandPreviewSink, W ~ ConversationWriter>(runner: R, preview: V, writer: W, session: string, request: CommandRequest, parent: i64) -> CommandOutput
    ![Memory, Command.run<DefaultCommandSandbox>, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
    writer.append(session, "operation", "command", request_text(request), parent);
    preview.show(request);
    let output = runner.run(request);
    writer.append(session, "operation_result", "command", step_result(output), parent);
    return output;
}
