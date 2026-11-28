module nomo.application.editing.ports;

import nomo.application.execution.ports.CommandOperations;
import nomo.application.harness.ports.{DiagnosticOutput, HarnessProgress};
import nomo.application.scope.SessionContext;
import nomo.core.conversation.Event;
import nomo.domain.changes.{Change, ChangeOutcome, FileChange, FileOutcome};
import nomo.domain.conversation.{ChatMessage, PendingRequest};
import nomo.domain.editing.{Confirmed, Prepared, Selector};
import nomo.domain.sessions.event_codec.Policy;
import nomo.domain.sessions.work.{Completed, Failure, Pending, Summary, WorkRequest};
import nomo.harness.harness_work_contract.Ledger;
import nomo.native.history.Session;
import nomo.native.mutations.{Journal, Step};
import nomo.native.workspace.ProjectRoot;
import nomo.session.edit_operation.Binding;
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError, Region};
import std.io.IOError;
import std.json.JsonValue;
import std.memory.MemoryVersion;

// Native approval is requested by the application and handled by the selected
// terminal/runtime adapter for the current invocation.
public effect Approval { action request(reason: string) -> bool; }

public type Preview = { binding: Binding, machine: string, diff: string };

public spec PreviewPresenter {
    flow present(self, preview: Preview) -> unit ![Console, Error<IOError>];
}

public spec CurrentEditConsent {
    flow confirm(self, preview: Preview) -> Result<Binding, string> ![Console, Approval, Error<IOError>];
}

public effect EditOriginal { action read(path: string) -> Result<string, string>; }

// The application requests the original text once. Native file exceptions
// escape unchanged; a returned refusal never implies a file was modified.
public spec OriginalReadFunction<R ~ Region>: callable string => Result<string, string> ![Fs.stat<R>, Fs.read<R>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];

public spec OriginalReader<R ~ Region> {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<R>, Fs.read<R>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec EditApplier<R ~ Region> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<R>, Fs.read<R>, Fs.atomic_replace<R>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];
}

public effect MutationFiles {
    action backup(id: string) -> string;
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
    flow backup(self, id: string) -> string ![];
    flow normalize(self, path: string) -> string ![];
    flow exists(self, path: string) -> bool ![Fs.list<ProjectRoot>, Error<fs_IOError>];
    flow read(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>];
    flow replace(self, path: string, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<fs_IOError>];
    flow command(self, program: string, arguments: Array<string>, call: i64) -> bool ![SessionContext.current, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>];
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

public spec MutationOutputSink { flow write(self, line: string) -> unit ![Console, Error<IOError>]; }

// The reusable work controller owns ordering and state transitions. Terminal
// formatting is selected at the composition boundary.
public spec WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<IOError>];
    flow diagnostic(self, line: string) -> unit ![Error<IOError>];
    flow recorded(self, selected: Selector) -> unit ![Error<IOError>, Error<IndexError>];
    flow ledger(self, state: Ledger, wide: bool, high_input: bool) -> unit ![Error<IOError>];
    flow refused(self, error: string) -> i32 ![Error<IOError>];
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool, high_input: bool) -> i32 ![Error<IOError>, Error<IndexError>];
}

public spec WorkStages {
    flow prepare(self, input: WorkRequest) -> Result<Pending, Failure> ![EditOriginal.read, HarnessProgress.write, DiagnosticOutput.write, Fs.read<ReadOnlyRoot>, Error<IOError>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];
    flow summarize(self, completed: Completed) -> Result<Summary, Failure> ![HarnessProgress.write, DiagnosticOutput.write, Error<IOError>, Error<IndexError>];
}

public spec WorkPersistence<Intent, Edited> {
    flow begin(self, binding: Binding) -> Result<Intent, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow complete(self, intent: Intent) -> Result<Edited, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow finish(self, edited: Edited, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec WorkConfirmation {
    flow confirm(self, selected: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec WorkTimeline {
    flow enabled(self) -> bool ![];
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>, Error<BudgetExceeded>];
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}

public type Run = { redaction: Policy, binding: string, wide: bool, high_input: bool, saved: string };

public type Ticket = { binding: Binding, version: MemoryVersion };
