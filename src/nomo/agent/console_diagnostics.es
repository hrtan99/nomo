module nomo.agent.console_diagnostics;

import std.io.println;
import std.io.IOError as ConsoleError;
import nomo.model.diagnostic_output.DiagnosticSink;

public type ConsoleDiagnostics = {};

impl ConsoleDiagnostics ~ DiagnosticSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
}
