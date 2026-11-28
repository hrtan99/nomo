module app.callable_negative;
import nomo.application.harness.ports.ProgressSink;
flow bad(value: i32) -> unit ~ ProgressSink {}
public flow observe(args: Array<string>) -> i32 { return 0; }
