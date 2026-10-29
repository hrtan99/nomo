module app.callable_negative;
import nomo.model.text_stage.TextModelStage;
flow bad(context: string) -> string ~ TextModelStage { return context; }
public flow observe(args: Array<string>) -> i32 { return 0; }
