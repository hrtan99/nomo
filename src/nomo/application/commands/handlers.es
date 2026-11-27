module nomo.application.commands.handlers;

import nomo.application.commands.service;
import std.io.IOError;
import nomo.application.commands.effects.CommandOperations;
import nomo.application.commands.ports.{CommandRunner, CommandPreviewSink};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, ResultPublication};


public flow bindings<H ~ ConversationReader + ConversationWriter + ResultPublication, A ~ AttemptRepository, R ~ CommandRunner, V ~ CommandPreviewSink>(history: H, attempts: A, runner: R, preview: V) -> ![CommandOperations => Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] ![] {
    return handler {
        CommandOperations.execute(session, mode, request) => service.run(runner, preview, attempts, history, history, history, session, mode, request);
        CommandOperations.step(session, request, parent) => service.step(runner, preview, history, session, request, parent);
    };
}
