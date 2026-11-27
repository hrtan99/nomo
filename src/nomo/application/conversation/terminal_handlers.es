module nomo.application.conversation.terminal_handlers;

import std.io.IOError;
import nomo.application.conversation.terminal_ports.{TerminalOutput, TerminalDisplay};

public flow output<D ~ TerminalDisplay>(display: D) -> ![TerminalOutput => Console, Error<IOError>] ![] {
    return handler { TerminalOutput.show(event) => display.show(event); };
}
