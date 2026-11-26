module nomo.application.conversation.service_ports;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.processes.ports.ProcessOperations;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.domain.configuration.settings.Settings;
import nomo.native.workspace.ProjectRoot;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;

public spec ConversationService {
    flow settings(self, session: string, check: Option<Array<string>>) -> Settings
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>];
    flow ask(self, session: string, request: string, check: Option<Array<string>>) -> bool
    ![Agentic, CommandOperations, ProjectInstructions, ChangeOperations, ProcessOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>];
    flow compact(self, session: string, settings: Settings) -> unit
    ![Agentic, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>];
}
