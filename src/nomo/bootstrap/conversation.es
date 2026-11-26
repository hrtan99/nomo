module nomo.bootstrap.conversation;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.processes.ports.ProcessOperations;
import nomo.application.mutations.ports.ChangeOperations;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.adapters.storage.attempts.NativeAttempts;
import nomo.adapters.storage.context_inputs.SavedJobContext;
import nomo.adapters.storage.processes.NativeJobs;
import nomo.adapters.filesystem.guidance.ProjectGuidance;
import nomo.bootstrap.instructions.reader as guidance;
import nomo.adapters.model.native.{NativeCodingModel, NativeSummaryModel};
import nomo.application.conversation.effects.{ConversationModel, ConversationOutput};
import nomo.application.conversation.session_context.SessionContext;
import nomo.application.context.effects.ConversationContext;
import nomo.application.context.acquire.build;
import nomo.application.conversation.turn.turn;
import nomo.application.conversation.compact.compact as compact_conversation;
import nomo.application.configuration.context.SettingsContext;
import nomo.adapters.model.context_projection.RollingContext;
import nomo.domain.configuration.settings.{Settings, with_check};
import nomo.bootstrap.configuration.load as load_configuration;

// Dependencies are constructed for this invocation. Settings/session are supplied
// to each operation, never retained as ambient state across conversation turns.
type Runtime = { history: NativeHistory, attempts: NativeAttempts, instructions: ProjectGuidance,
    jobs: SavedJobContext, coding: NativeCodingModel, summary: NativeSummaryModel, projection: RollingContext };

flow runtime() -> Runtime {
    return Runtime { history = NativeHistory {}, attempts = NativeAttempts {}, instructions = guidance(),
        jobs = SavedJobContext { jobs = NativeJobs {} }, coding = NativeCodingModel {}, summary = NativeSummaryModel {}, projection = RollingContext {} };
}

public flow settings_for(session: string, check: Option<Array<string>>) -> Settings
    ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>] {
    let value = handle load_configuration() with { SessionContext.current() => session; };
    return with_check(value, check);
}

public flow ask(session: string, request: string, check: Option<Array<string>>) -> bool
    ![Agentic, CommandOperations, ProjectInstructions, ChangeOperations, ProcessOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>] {
    let dependencies = runtime();
    return turn(dependencies.history, dependencies.history, dependencies.history, dependencies.attempts, dependencies.history, dependencies.projection, session, request) with {
        ConversationContext.settings(selected) => settings_for(selected, check);
        ConversationContext.acquire(selected, task, settings) => build(dependencies.history, dependencies.instructions, dependencies.attempts, dependencies.jobs, selected, task, settings);
        ConversationModel.code(input) => handle dependencies.coding.code(input) with {
            SessionContext.current() => input.session;
            SettingsContext.current() => input.settings;
        };
        ConversationModel.summarize(input) => dependencies.summary.summarize(input);
        ConversationOutput.write(line) => println(line);
    };
}

public flow compact(session: string, settings: Settings) -> unit
    ![Agentic, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let dependencies = runtime();
    compact_conversation(dependencies.history, dependencies.history, dependencies.attempts, dependencies.history, dependencies.projection, session, settings) with {
        ConversationContext.acquire(selected, task, configuration) => build(dependencies.history, dependencies.instructions, dependencies.attempts, dependencies.jobs, selected, task, configuration);
        ConversationModel.summarize(input) => dependencies.summary.summarize(input);
    };
}
