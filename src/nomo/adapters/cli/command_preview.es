module nomo.adapters.cli.command_preview;

import std.io.{println, IOError};
import nomo.domain.execution.command.CommandRequest;
import nomo.application.commands.ports.CommandPreviewSink;
import nomo.application.commands.encoding.preview_text;

public type ConsoleCommandPreview = {};

impl ConsoleCommandPreview ~ CommandPreviewSink {
    flow show(self, request: CommandRequest) -> unit ![Console, Error<IOError>] { println("[COMMAND] " + preview_text(request)); }
}
