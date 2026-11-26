module app.callable_negative;
import nomo.application.harness.ports.model_harness_progress.ProgressSink;
flow bad(value: string) -> unit ![Error<string>] ~ ProgressSink {
    if value != "" { perform Error<string>.raise("intentional outside-bound error"); }
}
public flow observe(args: Array<string>) -> i32 { return 0; }
