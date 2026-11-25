module nomo.application.native.command.ports;

import std.io.IOError;
import nomo.domain.execution.command.{CommandRequest, CommandOutput};

public spec CommandRunner {
    flow run(self, request: CommandRequest) -> CommandOutput ![Command.run<DefaultCommandSandbox>, Error<IOError>];
}

public spec CommandPreviewSink {
    flow show(self, request: CommandRequest) -> unit ![Console, Error<IOError>];
}
