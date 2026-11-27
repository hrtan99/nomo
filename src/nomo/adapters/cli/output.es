module nomo.adapters.cli.output;

import std.io.{println, IOError};
import nomo.application.conversation.service_ports.ConversationOutputSink;
import nomo.application.mutations.ports.MutationOutputSink;
import nomo.application.processes.ports.ProcessPreviewSink;

public type ConsoleLines = {};

impl ConsoleLines ~ ConversationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}

impl ConsoleLines ~ MutationOutputSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}

impl ConsoleLines ~ ProcessPreviewSink {
    flow write(self, line: string) -> unit ![Console, Error<IOError>] { println(line); }
}
