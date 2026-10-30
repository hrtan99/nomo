module app.callable_negative;
import nomo.model.harness_progress.ProgressSink;
flow bad(value: string) -> bool ~ ProgressSink { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
