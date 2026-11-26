module nomo.application.harness.ports.model_harness_progress;

import std.io.IOError as ConsoleError;

// One complete progress line. The application retains order and accounting.
public spec ConsoleProgressWriter: callable string => unit ![Error<ConsoleError>];

public spec ProgressSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>];
}
