module nomo.application.harness.work.ports;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.core.conversation.State;
import nomo.domain.harness.model_tool_contract.LoopTurn;
import nomo.domain.harness.harness_tool_contract.Context as ReadContext;
import nomo.domain.harness.harness_work_contract.Context;
import nomo.tools.workspace.ReadOnlyRoot;

public spec WorkModelStages {
    flow read(self, context: ReadContext) -> string ![];
    flow read_child(self, task: string, files: Array<string>, selected: State) -> LoopTurn ![Fs.read<ReadOnlyRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>];
    flow plan(self, context: Context) -> string ![];
    flow propose(self, context: Context) -> string ![];
    flow summarize(self, context: Context) -> string ![];
}
