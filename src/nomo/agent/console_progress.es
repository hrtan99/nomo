module nomo.agent.console_progress;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.model.harness_progress.{ConsoleProgressWriter, ProgressSink};

public flow write(line: string) -> unit ![Error<ConsoleError>] ~ ConsoleProgressWriter { println(line); }
public type ConsoleProgress = {};
public type SilentProgress = {};
impl ConsoleProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
}
impl SilentProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { return; }
}
