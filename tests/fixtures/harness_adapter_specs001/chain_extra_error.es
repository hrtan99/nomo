module app.callable_negative;
import nomo.harness.harness_tool_contract.Context as ReadContext;
import nomo.harness.harness_work_contract.Context as WorkContext;
import nomo.harness.work_chain_context.ParentFacts;
import nomo.harness.legacy_stage_contracts.{ReadMainStage, EditTextStage, ChainEditStage};
flow bad(context: WorkContext, parent: Array<ParentFacts>) -> string ![Error<string>] ~ ChainEditStage { if context.edit.request != "" { perform Error<string>.raise("intentional outside-bound error"); } return "unused"; }
public flow observe(args: Array<string>) -> i32 { return 0; }
