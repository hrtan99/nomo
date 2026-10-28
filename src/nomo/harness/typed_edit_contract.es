module nomo.harness.typed_edit_contract;

import nomo.harness.harness_work_contract.{Context, context_error};
import nomo.tools.edit_contribution.{Contribution, project};
import nomo.tools.edit_proposal.Proposal;

public flow input_error(context: Context) -> string {
    if context.edit.phase != "child" { return "typed edit pilot requires child context"; }
    return context_error(context);
}

// Pure proposal data is not current File observation, approval or a receipt.
// Existing confirmed apply/journal paths remain authoritative and unwired here.
public flow project_context(context: Context, value: Contribution) -> Result<Proposal, string> {
    let error = input_error(context); if error != "" { return Err(error); }
    return project(context.edit.path, context.edit.before, value);
}
