module app.callable_negative;
import nomo.domain.harness.text_stage.{Context};
import nomo.application.harness.ports.model_text_stage.{TextModelStage};
flow bad(context: Context) -> bool ~ TextModelStage { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
