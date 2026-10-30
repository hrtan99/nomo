module nomo.model.harness_progress;

import std.io.IOError as ConsoleError;

// One complete progress line. The application retains order and accounting.
public spec ProgressSink: callable string => unit ![Error<ConsoleError>];
public effect HarnessProgress { action write(line: string) -> unit; }
