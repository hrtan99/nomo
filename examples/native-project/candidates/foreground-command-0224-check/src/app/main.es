module app.main;
import nomo.adapters.command.foreground.HostCommandRunner;
import nomo.adapters.terminal.command_preview.ConsoleCommandPreview;
import nomo.application.native.command.ports.{CommandRunner, CommandPreviewSink};
import nomo.domain.execution.command.{CommandRequest, CommandOutput};
flow invoke<R ~ CommandRunner, P ~ CommandPreviewSink>(runner: R, preview: P, request: CommandRequest) -> CommandOutput {
    preview.show(request);
    return runner.run(request);
}
flow main(args: Array<string>) -> i32 {
    return invoke(HostCommandRunner {}, ConsoleCommandPreview {}, CommandRequest { program = "/usr/bin/true", arguments = [], stdin = None() }).exit_code;
}
