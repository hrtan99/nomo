module app.callable_negative;
import nomo.domain.harness.harness_tool_contract.Context as ReadContext;
import nomo.domain.harness.harness_work_contract.Context as WorkContext;
import nomo.domain.harness.work_chain_context.ParentFacts;
import nomo.domain.harness.legacy_stage_contracts.{ReadMainStage, EditTextStage, ChainEditStage};
flow bad(context: ReadContext) -> bool ~ ReadMainStage { return true; }
public flow observe(args: Array<string>) -> i32 { return 0; }
