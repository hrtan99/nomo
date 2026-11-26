module nomo.bootstrap.main;

import nomo.adapters.cli.conversation as entry;
import nomo.bootstrap.conversation;
import nomo.bootstrap.conversation.ConfiguredConversation;
import nomo.bootstrap.command;
import nomo.bootstrap.instructions;
import nomo.bootstrap.processes;
import nomo.bootstrap.transfer;
import nomo.bootstrap.projects;
import nomo.bootstrap.mutations;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.adapters.cli.conversation_picker.ConsoleConversationPicker;
import nomo.native.projects.LaunchRoot;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError;

alias NativeTerminal = entry.TerminalApplication<NativeHistory, NativeAttempts, ConsoleConversationPicker, ConfiguredConversation<NativeHistory, NativeAttempts>>;

public flow run(args: Array<string>) -> i32
    ![Agentic, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Fs.atomic_replace<LaunchRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<IOError>, Error<IndexError>] {
    let history = NativeHistory {};
    let attempts = NativeAttempts {};
    let application = entry.application<NativeHistory, NativeAttempts, ConsoleConversationPicker, ConfiguredConversation<NativeHistory, NativeAttempts>>() with {
        history: NativeHistory => history;
        attempts: NativeAttempts => attempts;
        picker: ConsoleConversationPicker => ConsoleConversationPicker {};
        conversation: ConfiguredConversation<NativeHistory, NativeAttempts> => conversation.create(history, attempts);
    };
    return execute(application, args);
}

// These scopes interpret requests made during execution, including model tools.
// Constructor providers above only select and store dependency values.
flow execute(application: NativeTerminal, args: Array<string>) -> i32 {
    return handle (
        handle (
            handle (
                handle (
                    handle (
                        handle application.run(args) with processes.bindings()
                    ) with transfer.operations()
                ) with projects.operations()
            ) with mutations.operations()
        ) with instructions.bindings()
    ) with command.bindings();
}
