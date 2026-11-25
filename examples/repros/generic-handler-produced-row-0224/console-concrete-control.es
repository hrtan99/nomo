module app.main;

import std.io.{println, IOError};
effect Output { action write(text: string) -> unit; }
spec Sink { flow write(self, text: string) -> unit ![Console, Error<IOError>]; }
type Terminal = {};
impl Terminal ~ Sink {
    flow write(self, text: string) -> unit ![Console, Error<IOError>] { println(text); }
}
flow bindings<S ~ Sink>(sink: S) -> ![Output => Console, Error<IOError>] ![] {
    return handler { Output.write(text) => { sink.write(text); resume; } };
}
public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    handle { perform Output.write("handler contract"); } with bindings(Terminal {});
    return 0;
}
