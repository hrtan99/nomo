module repro.application.command.ports;
import std.io.IOError;
import repro.domain.command.Request;
public spec PreviewSink {
    flow show(self, request: Request) -> unit ![Console, Error<IOError>];
}
