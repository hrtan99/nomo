module nomo.adapters.cli.processes;

import std.io.{println, IOError};
import nomo.application.processes.ports.ProcessPreviewSink;

public type TerminalProcessPreview = {};
impl TerminalProcessPreview ~ ProcessPreviewSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}
