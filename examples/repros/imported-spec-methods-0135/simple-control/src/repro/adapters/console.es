module repro.adapters.console;
import std.io.{println, IOError};
import repro.domain.command.Request;
import repro.application.command.ports.PreviewSink;
public type ConsolePreview = {};
impl ConsolePreview ~ PreviewSink {
    flow show(self, request: Request) -> unit ![Console, Error<IOError>] { println(request.program); }
}
