module nomo.harness.legacy_stage_contracts;

import nomo.harness.harness_tool_contract.Context as ReadContext;
import nomo.harness.harness_work_contract.Context as WorkContext;
import nomo.harness.harness_edit_contract.Context as StandaloneContext;
import nomo.harness.work_chain_context.ParentFacts;

// These are signatures of the existing interpreted stages; they do not grant
// File, model budget, parent authority or permission to replay prior work.
public spec ReadMainStage: callable ReadContext => string ![];
public spec EditTextStage: callable WorkContext => string ![];
public spec StandaloneEditStage: callable StandaloneContext => string ![];
public spec ChainEditStage: callable (WorkContext, Array<ParentFacts>) => string ![Error<IndexError>];
