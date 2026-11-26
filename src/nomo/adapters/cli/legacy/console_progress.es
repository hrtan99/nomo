module nomo.adapters.cli.legacy.console_progress;

import std.io.{println, IOError as ConsoleError};
import nomo.application.harness.ports.model_harness_progress.{ConsoleProgressWriter, ProgressSink};

public flow write(line: string) -> unit ![Error<ConsoleError>] ~ ConsoleProgressWriter { println(line); }

public type ConsoleProgress = {};

public type SilentProgress = {};

impl ConsoleProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
}

impl SilentProgress ~ ProgressSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { return; }
}
