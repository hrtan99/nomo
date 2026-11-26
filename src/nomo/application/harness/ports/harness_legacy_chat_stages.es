module nomo.application.harness.ports.harness_legacy_chat_stages;

import std.effects.Fs;
import std.fs.{Region, IOError as FileError};
import std.io.IOError as ConsoleError;
import nomo.core.conversation.State;
import nomo.domain.harness.model_tool_contract.LoopTurn;

public spec ChatMainStage: callable Context => string ![];

public spec ChatChildStage<R ~ Region>: callable (string, Array<string>, State) => LoopTurn ![Fs.read<R>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];

public spec WideChatChildStage<R ~ Region>: callable (string, Array<string>, State, bool, bool) => LoopTurn ![Fs.read<R>, Error<ConsoleError>, Error<FileError>, Error<IndexError>];
