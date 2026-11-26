module app.callable_negative;
import nomo.domain.harness.harness_work_contract.Context as WorkContext;
import nomo.domain.harness.legacy_stage_contracts.ChainEditStage;
flow bad(context: WorkContext, parent: string) -> string ~ ChainEditStage { return "unused"; }
public flow observe(args: Array<string>) -> i32 { return 0; }
