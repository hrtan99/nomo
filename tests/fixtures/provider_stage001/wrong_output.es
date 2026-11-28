module app.callable_negative;
import nomo.application.harness.ports.Context;
import nomo.application.harness.ports.TextModelStage;
flow bad(context: Context) -> bool ~ TextModelStage { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
