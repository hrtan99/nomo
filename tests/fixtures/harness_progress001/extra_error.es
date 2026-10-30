module app.callable_negative;
import nomo.model.harness_progress.ProgressSink;
flow bad(value: string) -> unit ![Error<string>] ~ ProgressSink {
    if value != "" { perform Error<string>.raise("intentional outside-bound error"); }
}
public flow observe(args: Array<string>) -> i32 { return 0; }
