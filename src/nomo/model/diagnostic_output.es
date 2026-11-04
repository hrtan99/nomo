module nomo.model.diagnostic_output;

import std.io.IOError as ConsoleError;

// Diagnostics are terminal observations, not conversation events or budget
// progress. Keeping a distinct sink prevents controllers from printing while
// preserving the legacy trace and incomplete-search messages exactly.
public spec DiagnosticSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>];
}

public effect DiagnosticOutput { action write(line: string) -> unit; }
