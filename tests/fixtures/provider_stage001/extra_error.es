module app.callable_negative;
import nomo.application.harness.ports.Context;
import nomo.application.harness.ports.TextModelStage;
flow bad(context: Context) -> string ![Error<string>] ~ TextModelStage {
    if context.request != "" { perform Error<string>.raise("intentional outside-bound error"); }
    return "unused";
}
public flow observe(args: Array<string>) -> i32 { return 0; }
