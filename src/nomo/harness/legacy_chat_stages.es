module nomo.harness.legacy_chat_stages;

import std.effects.Fs;
import std.fs.Region;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import nomo.harness.harness_tool_chat_contract.Context;
import nomo.core.conversation.State;
import nomo.model.model_tool_contract.LoopTurn;

public spec ChatMainStage: callable Context => string ![];
public spec ChatChildStage<R ~ Region>: callable (string, Array<string>, State) => LoopTurn ![Fs.read<R>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
public spec WideChatChildStage<R ~ Region>: callable (string, Array<string>, State, bool, bool) => LoopTurn ![Fs.read<R>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
public effect LegacyChatStages {
    action main(context: Context) -> string;
    action child(task: string, allowed: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn;
}
