module nomo.application.harness.ports.harness_chat_stages;

import std.effects.Fs;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.core.conversation.State;
import nomo.domain.harness.model_tool_contract.LoopTurn;
import nomo.domain.harness.harness_tool_chat_contract.Context;

public spec ReadStages {
    flow main(self, context: Context) -> string ![];
    flow child(self, task: string, files: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn ![Fs.read<ReadOnlyRoot>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
}
