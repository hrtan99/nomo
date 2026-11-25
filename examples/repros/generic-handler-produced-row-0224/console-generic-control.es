module app.main;

import std.io.{println, IOError};
effect Output { action write(text: string) -> unit; }
spec Sink { flow write(self, text: string) -> unit ![Console, Error<IOError>]; }
flow bindings<S ~ Sink>(sink: S) -> ![Output => Console, Error<IOError>] ![] {
    return handler { Output.write(text) => { sink.write(text); resume; } };
}
public flow use<S ~ Sink>(sink: S) -> unit ![Console, Error<IOError>] {
    handle { perform Output.write("handler contract"); } with bindings(sink);
}
public flow main(args: Array<string>) -> i32 { return 0; }
