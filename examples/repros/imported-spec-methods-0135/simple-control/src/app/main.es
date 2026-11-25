module app.main;
import repro.adapters.console.ConsolePreview;
import repro.application.command.ports.PreviewSink;
import repro.domain.command.Request;
flow preview<P ~ PreviewSink>(sink: P, request: Request) -> unit { sink.show(request); }
flow main(args: Array<string>) -> i32 {
    preview(ConsolePreview {}, Request { program = "synthetic", arguments = [], stdin = None() });
    return 0;
}
