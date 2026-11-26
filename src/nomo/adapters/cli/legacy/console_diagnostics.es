module nomo.adapters.cli.legacy.console_diagnostics;

import std.io.{println, IOError as ConsoleError};
import nomo.application.harness.ports.model_diagnostic_output.DiagnosticSink;

public type ConsoleDiagnostics = {};

impl ConsoleDiagnostics ~ DiagnosticSink {
    flow write(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
}
