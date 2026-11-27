module nomo.application.mutations.ports;

import nomo.application.commands.effects.CommandOperations;
import std.json.JsonValue;
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.domain.conversation.session.Session;
import nomo.domain.conversation.history.PendingRequest;
import nomo.domain.conversation.messages.ChatMessage;
import nomo.domain.mutations.models.{Change, ChangeOutcome, Journal, Step, FileChange, FileOutcome};

public effect MutationFiles {
    action normalize(path: string) -> string;
    action exists(path: string) -> bool;
    action read(path: string) -> string;
    action replace(path: string, text: string) -> unit;
    action command(program: string, arguments: Array<string>, call: i64) -> bool;
}
public effect ChangeJournal {
    action lookup(id: string) -> Option<Journal>;
    action insert(value: Journal) -> unit;
    action save(value: Journal) -> unit;
    action step(key: string) -> Option<Step>;
    action save_step(key: string, value: Step) -> unit;
    action list(session: string) -> Array<Journal>;
}
public effect MutationHistory {
    action record(role: string, name: string, value: JsonValue, call: i64) -> i64;
    action finish(name: string, call: i64, value: JsonValue) -> unit;
    action session(id: string) -> Session;
    action pending(id: string) -> Option<PendingRequest>;
    action message(id: string, index: i64) -> ChatMessage;
    action published(id: string, call: i64, name: string) -> bool;
}
public effect MutationOutput { action write(line: string) -> unit; }

// Model/terminal entry adapters carry the session explicitly across handlers.
public effect ChangeOperations {
    action replace(session: string, change: FileChange) -> FileOutcome;
    action inspect(session: string) -> Array<Journal>;
    action apply(session: string, name: string, changes: Array<Change>) -> ChangeOutcome;
    action undo(session: string, edit: string) -> ChangeOutcome;
    action rollback(session: string, edit: string) -> ChangeOutcome;
    action reconcile(session: string, edit: string) -> ChangeOutcome;
    action list(session: string) -> Array<Journal>;
}

public spec MutationFileAccess {
    flow normalize(self, path: string) -> string ![];
    flow exists(self, path: string) -> bool ![Fs.list<ProjectRoot>, Error<FileError>];
    flow read(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
    flow replace(self, path: string, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<FileError>];
    flow command(self, program: string, arguments: Array<string>, call: i64) -> bool ![SessionContext.current, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>];
}
public spec ChangeJournalStore {
    flow lookup(self, id: string) -> Option<Journal> ![Memory, Error<StorageError>];
    flow insert(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow save(self, value: Journal) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow step(self, key: string) -> Option<Step> ![Memory, Error<StorageError>];
    flow save_step(self, key: string, value: Step) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow list(self, session: string) -> Array<Journal> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}
public spec MutationHistoryStore {
    flow record(self, role: string, name: string, value: JsonValue, call: i64) -> i64 ![SessionContext.current, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
    flow finish(self, name: string, call: i64, value: JsonValue) -> unit ![SessionContext.current, Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>];
    flow pending(self, id: string) -> Option<PendingRequest> ![Memory, Error<StorageError>];
    flow published(self, id: string, call: i64, name: string) -> bool ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}
public spec MutationOutputSink { flow write(self, line: string) -> unit ![Console, Error<ConsoleError>]; }
