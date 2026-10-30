module nomo.agent.console_progress;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.model.harness_progress.ProgressSink;

public flow write(line: string) -> unit ![Error<ConsoleError>] ~ ProgressSink { println(line); }
