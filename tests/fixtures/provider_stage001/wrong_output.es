module app.callable_negative;
import nomo.model.text_stage.{Context, TextModelStage};
flow bad(context: Context) -> bool ~ TextModelStage { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
