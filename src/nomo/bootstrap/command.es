module nomo.bootstrap.command;

import nomo.application.commands.service;
import std.io.IOError;
import nomo.application.commands.effects.CommandOperations;
import nomo.adapters.process.foreground.HostCommandRunner;
import nomo.adapters.cli.command_preview.ConsoleCommandPreview;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.adapters.storage.conversations.NativeHistory;

public flow bindings() -> ![CommandOperations => Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] ![] {
    let runner = HostCommandRunner {}; let preview = ConsoleCommandPreview {};
    let attempts = NativeAttempts {}; let history = NativeHistory {};
    return handler {
        CommandOperations.execute(session, mode, request) => service.run(runner, preview, attempts, history, history, history, session, mode, request);
        CommandOperations.step(session, request, parent) => service.step(runner, preview, history, session, request, parent);
    };
}
