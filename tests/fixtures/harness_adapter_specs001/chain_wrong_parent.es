module app.callable_negative;
import nomo.domain.harness.work.Context as WorkContext;
import nomo.application.harness.ports.ChainEditStage;
flow bad(context: WorkContext, parent: string) -> string ~ ChainEditStage { return "unused"; }
public flow observe(args: Array<string>) -> i32 { return 0; }
