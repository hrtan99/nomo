module nomo.adapters.model.native;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.processes.ports.ProcessOperations;
import nomo.application.mutations.ports.ChangeOperations;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.conversation.effects.{CodingModel, SummaryModel};
import nomo.application.configuration.context.SettingsContext;
import nomo.domain.conversation.turn.{Turn, Answer, Summary};
import nomo.adapters.model.coding_agent.NativeCoding;
import nomo.adapters.model.context.CompactHistory;

public type NativeCodingModel = {};
impl NativeCodingModel ~ CodingModel {
    flow code(self, input: Turn) -> Answer ![CommandOperations, ProjectInstructions, ChangeOperations, ProcessOperations, Memory, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Console, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] {
        return handle (NativeCoding {}).run(input) with {
            SessionContext.current() => input.session;
            SettingsContext.current() => input.settings;
        };
    }
}

public type NativeSummaryModel = {};
impl NativeSummaryModel ~ SummaryModel {
    flow summarize(self, input: Turn) -> Summary ![] { return (CompactHistory {}).run(input); }
}
