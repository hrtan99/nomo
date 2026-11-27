module nomo.application.conversation.effects;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.workspace.ports.WorkspaceObservations;
import nomo.application.processes.ports.ProcessOperations;
import nomo.application.mutations.ports.ChangeOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.conversation.turn.{Turn, Answer, Summary};

public effect ConversationModel {
    action code(input: Turn) -> Answer;
    action summarize(input: Turn) -> Summary;
}

public effect ConversationOutput { action write(line: string) -> unit; }

public spec CodingModel {
    flow code(self, input: Turn) -> Answer ![CommandOperations, WorkspaceObservations, ChangeOperations, ProcessOperations, Memory, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Console, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>];
}

public spec SummaryModel {
    flow summarize(self, input: Turn) -> Summary ![];
}
