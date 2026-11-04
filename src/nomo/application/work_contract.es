module nomo.application.work_contract;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.cli.harness_work_args.Work;
import nomo.core.conversation.Event;
import nomo.core.conversation.State;
import nomo.model.model_tool_contract.LoopTurn;
import nomo.harness.harness_tool_contract.Context as ReadContext;
import nomo.harness.harness_work_contract.{Context, Evidence, Ledger};
import nomo.tools.edit_contract.{Selector, Prepared};
import nomo.tools.edit_file.EditableRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.session.edit_operation.Binding;
import nomo.session.redaction.Policy;

public type Failure = { state: Ledger, error: string };
public type Pending = { selected: Selector, prepared: Prepared, evidence: Evidence, request: string, task: string, state: Ledger };
public type Completed = { context: Context, state: Ledger };
public type Summary = { answer: string, state: Ledger, model_generated: bool };
public spec WorkModelStages {
    flow read(self, context: ReadContext) -> string ![];
    flow read_child(self, task: string, files: Array<string>, selected: State) -> LoopTurn ![Fs.read<ReadOnlyRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
    flow plan(self, context: Context) -> string ![];
    flow propose(self, context: Context) -> string ![];
    flow summarize(self, context: Context) -> string ![];
}
public spec WorkStages {
    flow prepare(self, input: Work) -> Result<Pending, Failure> ![Console, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
    flow summarize(self, completed: Completed) -> Result<Summary, Failure> ![Console, Error<ConsoleError>, Error<IndexError>];
}
public spec WorkPersistence<Intent, Edited> {
    flow begin(self, binding: Binding) -> Result<Intent, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow complete(self, intent: Intent) -> Result<Edited, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow finish(self, edited: Edited, summary: Summary, records: Array<Event>) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>];
}
public type Run = { redaction: Policy, binding: string, wide: bool, saved: string };
