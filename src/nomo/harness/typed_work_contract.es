module nomo.harness.typed_work_contract;

import nomo.model.model_tool_contract.{Action, question_error, allowed_error, read_selection_error};
import nomo.model.model_tool_contract.Context as ToolContext;
import nomo.model.model_tool_contract.context_error as tool_context_error;
import nomo.harness.harness_tool_contract.Context as ReadContext;
import nomo.harness.harness_tool_contract.context_error as read_context_error;
import nomo.harness.harness_model_contract.{bounded, read_aggregate_error};
import nomo.harness.harness_work_contract.{Evidence, context_error, finish_evidence};
import nomo.harness.harness_edit_contract.{text_error, work_summary_error};
import nomo.harness.work_chain_context.Input;
import nomo.harness.typed_edit_contract.project_context;
import nomo.tools.edit_contribution.Contribution;
import nomo.tools.edit_proposal.Proposal;

public type Delegation = { task: string };
public type ReadAction = { operation: string, files: Array<string>, literal: string };
public type Answer = { text: string };

public flow read_input_error(context: ReadContext, phase: string) -> string {
    if (phase != "plan" && phase != "aggregate") || context.phase != phase { return "typed read context phase mismatch"; }
    let request = question_error(context.request); if request != "" { return request; }
    let allowed = allowed_error(context.allowed); if allowed != "" { return allowed; }
    return read_context_error(context);
}
public flow child_input_error(context: ToolContext, final_only: bool) -> string {
    if context.final_only != final_only { return "typed child context phase mismatch"; }
    let allowed = allowed_error(context.allowed); if allowed != "" { return allowed; }
    return tool_context_error(context);
}
public flow edit_input_error(input: Input, phase: string) -> string {
    if (phase != "plan" && phase != "child" && phase != "aggregate") || input.current.edit.phase != phase {
        return "typed edit context phase mismatch";
    }
    return context_error(input.current);
}

public flow project_read_plan(context: ReadContext, value: Delegation) -> Result<string, string> {
    let invalid = read_input_error(context, "plan"); if invalid != "" { return Err(invalid); }
    if !bounded(value.task, 128) { return Err("invalid bounded delegated task"); }
    return Ok(value.task);
}
public flow project_read_action(context: ToolContext, value: ReadAction) -> Result<Action, string> {
    let invalid = child_input_error(context, false); if invalid != "" { return Err(invalid); }
    let selected = read_selection_error(value.operation, value.files, value.literal, context.allowed);
    if selected != "" { return Err(selected); }
    return Ok(Action { operation = value.operation, files = value.files, literal = value.literal, text = "" });
}
public flow project_read_final(context: ToolContext, value: Answer) -> Result<Action, string> {
    let invalid = child_input_error(context, true); if invalid != "" { return Err(invalid); }
    if !bounded(value.text, 256) { return Err("invalid bounded child final answer"); }
    return Ok(Action { operation = "final", files = [], literal = "", text = value.text });
}
public flow project_read_aggregate(context: ReadContext, value: Answer) -> Result<string, string> {
    let invalid = read_input_error(context, "aggregate"); if invalid != "" { return Err(invalid); }
    let summary = read_aggregate_error(value.text); if summary != "" { return Err(summary); }
    return Ok(value.text);
}

// Preserve the controller-supplied actual selection, complete outcome and ledger.
// A typed summary cannot replace them or manufacture a successful tool result.
public flow settle_read(pending: Evidence, value: Answer) -> Result<Evidence, string> {
    let invalid = read_aggregate_error(value.text); if invalid != "" { return Err(invalid); }
    return finish_evidence(pending, value.text);
}
public flow project_edit_plan(input: Input, value: Delegation) -> Result<string, string> {
    let invalid = edit_input_error(input, "plan"); if invalid != "" { return Err(invalid); }
    let task = text_error(value.task, "delegated task"); if task != "" { return Err(task); }
    return Ok(value.task);
}
public flow project_edit_child(input: Input, value: Contribution) -> Result<Proposal, string> {
    let invalid = edit_input_error(input, "child"); if invalid != "" { return Err(invalid); }
    return project_context(input.current, value);
}
public flow project_edit_aggregate(input: Input, value: Answer) -> Result<string, string> {
    let invalid = edit_input_error(input, "aggregate"); if invalid != "" { return Err(invalid); }
    let summary = work_summary_error(value.text); if summary != "" { return Err(summary); }
    return Ok(value.text);
}
