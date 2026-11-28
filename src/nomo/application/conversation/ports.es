module nomo.application.conversation.ports;

import nomo.application.editing.ports.ChangeOperations;
import nomo.application.execution.ports.{CommandOperations, ProcessOperations};
import nomo.application.resources.ProjectRoot;
import nomo.application.workspace.ports.WorkspaceObservations;
import nomo.domain.archives.ConversationCopy;
import nomo.domain.attempts.ExecutionAttempt;
import nomo.domain.changes.{ChangeOutcome, FileJournal};
import nomo.domain.commands.{CheckOutcome, Command as commands_Command, CommandOutput};
import nomo.domain.conversation.{Answer, ChatMessage, ModelTurn, SavedSession, Summary};
import nomo.domain.processes.{
    ArchivedProcessJob as processes_ArchivedJob,
    ArchivedOutput as processes_ArchivedOutput,
    InputResult,
    ProcessJob as ProcessJobRecord,
    ProcessOutput
};
import nomo.domain.settings.{ConfigurationStatus, Settings};
import nomo.domain.workspace.FileContent;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError};
import std.io.IOError;

public effect ConversationContext {
    action settings(session: string) -> Settings;
    action acquire(session: string, request: string, settings: Settings) -> ModelTurn;
}

public spec ContextProjection {
    flow bytes(self, input: ModelTurn) -> usize ![];
    flow needs_compaction(self, input: ModelTurn) -> bool ![];
}

public spec SavedJobsReader {
    flow read(self, session: string) -> Array<ProcessJobRecord> ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ];
}

public effect ConversationModel {
    action code(input: ModelTurn) -> Answer;
    action summarize(input: ModelTurn) -> Summary;
}

public effect ConversationOutput {
    action write(line: string) -> unit;
}

public spec CodingModel {
    flow code(self, input: ModelTurn) -> Answer ![
        CommandOperations,
        WorkspaceObservations,
        ChangeOperations,
        ProcessOperations,
        Memory,
        Command.run<DefaultCommandSandbox>,
        Command.start<DefaultCommandSandbox>,
        Command.reconnect<DefaultCommandSandbox>,
        Command.read<DefaultCommandSandbox>,
        Command.write<DefaultCommandSandbox>,
        Command.stop<DefaultCommandSandbox>,
        Console,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Fs.stat<ProjectRoot>,
        Fs.atomic_replace<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IOError>,
        Error<BudgetExceeded>
    ];
}

public spec SummaryModel {
    flow summarize(self, input: ModelTurn) -> Summary ![];
}

public spec ConversationPicker {
    flow choose(self, sessions: Array<SavedSession>) -> Option<string> ![Console, Error<IOError>];
}

public spec ConversationReader {
    flow load(self, id: string) -> SavedSession ![Memory, Error<StorageError>];
    flow message(self, id: string, index: i64) -> ChatMessage ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ];
    flow messages(self, id: string, after: i64) -> Array<ChatMessage> ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ];
}

public spec ConversationWriter {
    flow append(self, id: string, role: string, name: string, text: string, call: i64) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ];
}

public spec ConversationCatalog {
    flow rename(self, id: string, title: string) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow create(self, workspace: string, title: string) -> SavedSession ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ];
    flow selected(self, workspace: string) -> Option<string> ![Memory, Error<StorageError>];
    flow select(self, workspace: string, id: string) -> SavedSession ![Memory, Error<StorageError>];
    flow sessions(self, workspace: string) -> Array<SavedSession> ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ];
    flow all_sessions(self) -> Array<SavedSession> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}

public spec GenerationReservation {
    flow reserve(self, id: string, compact: bool, context_bytes: usize) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ];
}

public spec ResultPublication {
    flow prepare_result(self, id: string, role: string, name: string, call: i64) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ];
    flow publish_result(self, id: string, index: i64, text: string) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ];
    flow result_complete(self, id: string, index: i64) -> bool ![Memory, Error<StorageError>];
    flow select_summary(self, id: string, index: i64, through: i64) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ];
    flow finish_command(self, id: string, call: i64) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ];
    flow acknowledge(self, id: string, call: i64, note: string) -> i64 ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<BudgetExceeded>
    ];
}

public spec ConversationService {
    flow settings(self, session: string, check: Option<Array<string>>) -> Settings
    ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ];
    flow ask(self, session: string, request: string, check: Option<Array<string>>) -> bool
    ![
        Agentic,
        CommandOperations,
        WorkspaceObservations,
        ChangeOperations,
        ProcessOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Command.start<DefaultCommandSandbox>,
        Command.reconnect<DefaultCommandSandbox>,
        Command.read<DefaultCommandSandbox>,
        Command.write<DefaultCommandSandbox>,
        Command.stop<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Fs.stat<ProjectRoot>,
        Fs.atomic_replace<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<IOError>,
        Error<BudgetExceeded>
    ];
    flow compact(self, session: string, settings: Settings) -> unit
    ![
        Agentic,
        Memory,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ];
}

// These roles belong to the conversation consumer, independently of configuration IO and CLI rendering.
public spec ConversationConfiguration {
    flow load(self, session: string) -> Settings
    ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ];
}

public spec ConversationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>];
}

public enum TerminalEvent {
    Message(string),
    Help,
    Welcome,
    Project(string),
    SessionHeader(SavedSession),
    CopyState(ConversationCopy),
    Pending(string),
    UnresolvedAttempt(ExecutionAttempt),
    History(ChatMessage),
    MoreHistory(i64),
    Status(SavedSession),
    Git(CommandOutput),
    CommandResult(CommandOutput),
    ProcessJob(ProcessJobRecord),
    JobRead(ProcessOutput),
    JobInput(InputResult),
    JobOutput(Array<ProcessOutput>),
    ArchivedProcessJob(processes_ArchivedJob),
    ArchivedOutput(processes_ArchivedOutput),
    Discovery(CommandOutput),
    File(FileContent),
    Edit(FileJournal),
    EditResult(ChangeOutcome),
    Copy(ConversationCopy),
    UnfinishedCopy(ConversationCopy),
    Run(ExecutionAttempt),
    Resolved(ExecutionAttempt),
    Config(ConfigurationStatus),
    Check(CheckOutcome)
}

public spec TerminalInput {
    flow next(self) -> Option<commands_Command> ![Console, Error<IOError>];
}

public spec TerminalDisplay {
    flow show(self, event: TerminalEvent) -> unit ![Console, Error<IOError>];
}

public effect TerminalOutput {
    action show(event: TerminalEvent) -> unit;
}
