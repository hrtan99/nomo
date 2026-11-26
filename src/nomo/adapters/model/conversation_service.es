module nomo.adapters.model.conversation_service;

import nomo.application.conversation.service_ports.ConversationService;

import nomo.application.commands.effects.CommandOperations;
import nomo.application.instructions.ports.ProjectInstructions;
import nomo.application.processes.ports.ProcessOperations;
import nomo.application.mutations.ports.ChangeOperations;
import nomo.application.conversation.ports.{ConversationReader, ConversationWriter, GenerationReservation, ResultPublication};
import nomo.application.execution.ports.AttemptRepository;
import nomo.application.context.ports.{InstructionReader, SavedJobsReader, ContextProjection};
import nomo.application.conversation.effects.{ConversationModel, ConversationOutput, CodingModel, SummaryModel};
import nomo.application.context.effects.ConversationContext;
import nomo.application.context.acquire.build;
import nomo.application.conversation.turn.turn;
import nomo.application.conversation.compact.compact as compact_conversation;
import nomo.domain.configuration.settings.{Settings, with_check};
import nomo.native.workspace.ProjectRoot;
import std.io.{println, IOError as ConsoleError};
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};

// Dependencies are resolved at construction. Session/settings stay local to each call.
public type NativeConversation<
    History ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication,
    Attempts ~ AttemptRepository,
    Instructions ~ InstructionReader,
    Jobs ~ SavedJobsReader,
    Coding ~ CodingModel,
    Summary ~ SummaryModel,
    Projection ~ ContextProjection
> = {
    @inject history: History,
    @inject attempts: Attempts,
    @inject instructions: Instructions,
    @inject jobs: Jobs,
    @inject coding: Coding,
    @inject summary: Summary,
    @inject projection: Projection,
    configuration: (string) -> Settings ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>],
};

impl NativeConversation<
    History ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication,
    Attempts ~ AttemptRepository,
    Instructions ~ InstructionReader,
    Jobs ~ SavedJobsReader,
    Coding ~ CodingModel,
    Summary ~ SummaryModel,
    Projection ~ ContextProjection
> ~ ConversationService {

    public flow settings(self, session: string, check: Option<Array<string>>) -> Settings
        ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] {
        let value = (self.configuration)(session);
        return with_check(value, check);
    }

    public flow ask(self, session: string, request: string, check: Option<Array<string>>) -> bool
        ![Agentic, CommandOperations, ProjectInstructions, ChangeOperations, ProcessOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Command.start<DefaultCommandSandbox>, Command.reconnect<DefaultCommandSandbox>, Command.read<DefaultCommandSandbox>, Command.write<DefaultCommandSandbox>, Command.stop<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Fs.atomic_replace<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<ConsoleError>, Error<BudgetExceeded>] {
        let dependencies = self;
        return turn(dependencies.history, dependencies.history, dependencies.history, dependencies.attempts, dependencies.history, dependencies.projection, session, request) with {
            ConversationContext.settings(selected) => self.settings(selected, check);
            ConversationContext.acquire(selected, task, settings) => build(dependencies.history, dependencies.instructions, dependencies.attempts, dependencies.jobs, selected, task, settings);
            ConversationModel.code(input) => dependencies.coding.code(input);
            ConversationModel.summarize(input) => dependencies.summary.summarize(input);
            ConversationOutput.write(line) => println(line);
        };
    }

    public flow compact(self, session: string, settings: Settings) -> unit
        ![Agentic, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] {
        let dependencies = self;
        compact_conversation(dependencies.history, dependencies.history, dependencies.attempts, dependencies.history, dependencies.projection, session, settings) with {
            ConversationContext.acquire(selected, task, configuration) => build(dependencies.history, dependencies.instructions, dependencies.attempts, dependencies.jobs, selected, task, configuration);
            ConversationModel.summarize(input) => dependencies.summary.summarize(input);
        };
    }
}

public flow create<
    History ~ ConversationReader + ConversationWriter + GenerationReservation + ResultPublication,
    Attempts ~ AttemptRepository,
    Instructions ~ InstructionReader,
    Jobs ~ SavedJobsReader,
    Coding ~ CodingModel,
    Summary ~ SummaryModel,
    Projection ~ ContextProjection
>(configuration: (string) -> Settings ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>]) -> NativeConversation<History, Attempts, Instructions, Jobs, Coding, Summary, Projection> {
    return NativeConversation<History, Attempts, Instructions, Jobs, Coding, Summary, Projection> { configuration };
}
