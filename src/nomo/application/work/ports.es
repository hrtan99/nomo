module nomo.application.work.ports;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.request.WorkRequest;
import nomo.application.edit.effects.Approval;
import nomo.core.conversation.Event;
import nomo.application.harness.effects.harness_edit_original.EditOriginal;
import nomo.application.harness.effects.model_diagnostic_output.DiagnosticOutput;
import nomo.application.harness.effects.model_harness_progress.HarnessProgress;
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.redaction.Policy;
import nomo.domain.mutations.edit_contract.{Selector, Prepared, Confirmed};
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.domain.work.protocol.{Failure, Pending, Completed, Summary};

public spec WorkStages {
    flow prepare(self, input: WorkRequest) -> Result<Pending, Failure> ![EditOriginal.read, HarnessProgress.write, DiagnosticOutput.write, Fs.read<ReadOnlyRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];
    flow summarize(self, completed: Completed) -> Result<Summary, Failure> ![HarnessProgress.write, DiagnosticOutput.write, Error<ConsoleError>, Error<IndexError>];
}

public spec WorkPersistence<Intent, Edited> {
    flow begin(self, binding: Binding) -> Result<Intent, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow complete(self, intent: Intent) -> Result<Edited, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
    flow finish(self, edited: Edited, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];
    flow confirm(self, selected: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>, Error<IndexError>, Error<BudgetExceeded>];
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];
}

public spec WorkTimeline {
    flow enabled(self) -> bool ![];
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>, Error<BudgetExceeded>];
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>];
}

public type Run = { redaction: Policy, binding: string, wide: bool, high_input: bool, saved: string };
