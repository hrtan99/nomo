module app.callable_negative;
import nomo.domain.harness.text_stage.{Context};
import nomo.application.harness.ports.model_text_stage.{TextModelStage};
flow bad(context: Context) -> string ![Error<string>] ~ TextModelStage {
    if context.request != "" { perform Error<string>.raise("intentional outside-bound error"); }
    return "unused";
}
public flow observe(args: Array<string>) -> i32 { return 0; }
