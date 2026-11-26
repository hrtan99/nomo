module nomo.adapters.cli.mutations;

import std.io.{println, IOError};
import nomo.application.mutations.ports.MutationOutputSink;

public type TerminalMutationOutput = {};
impl TerminalMutationOutput ~ MutationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}
