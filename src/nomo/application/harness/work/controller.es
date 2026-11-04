module nomo.application.harness.work.controller;

import std.text.to_string_i32;
import nomo.application.work.request.WorkRequest;
import nomo.application.work.ports.{Failure, Pending, Completed, Summary};
import nomo.harness.harness_work_contract.{Context, Ledger, WorkBudgetPolicy, HistoricalWorkBudget, ExpandedWorkBudget, LargeWorkBudget, fresh, ledger_error, bump_edit, native_tokens, native_budget, collect, finish_evidence, context_error};
import nomo.harness.harness_model_tools.{run_context as read_context, Report as ReadReport, Failure as ReadFailure};
import nomo.harness.read_model_tools.{run_context as unicode_read_context, run_expanded_context};
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.legacy_string_stages.LegacyEditStages;
import nomo.harness.edit_original.EditOriginal;
import nomo.harness.harness_edit_contract.{decode_plan, decode_edit, decode_empty_edit, text_error, history_summary_error, history_fallback_summary, decode_work_plan, decode_work_edit, work_summary_error};
import nomo.harness.edit_context.{context, completed_context};
import nomo.harness.model_plan_diagnostic.{response_error, response_text};
import nomo.model.harness_progress.HarnessProgress;
import nomo.model.diagnostic_output.DiagnosticOutput;
import nomo.tools.edit_contract.Confirmed;
import nomo.tools.edit_file.{prepare_original, prepare_original_legacy};
import nomo.tools.edit_encoding.json;

flow failed(state: Ledger, error: string) -> Result<Pending, Failure> {
    return Err(Failure { state = state, error = error });
}

flow progress(line: string) -> unit { perform HarnessProgress.write(line); }
flow diagnostic(line: string) -> unit { perform DiagnosticOutput.write(line); }
flow display(prefix: string, text: string) -> unit {
    match json([text]) { Ok(value) => { progress(prefix + value); } Err(error) => { abort(error); } }
}

public flow historical_ledger_text(state: Ledger) -> string {
    return "LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" +
        to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) +
        "/47104 historical_native_allowance=" + to_string_i32(native_tokens(state)) + "/196608";
}
public flow expanded_ledger_text(state: Ledger, wide: bool) -> string {
    return "LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" +
        to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) +
        (if wide { "/286720 native_configured=" } else { "/51200 native_configured=" }) + to_string_i32(native_budget(state)) +
        if wide { "/2811008; configured allowances are not measured usage" } else { "/1335296; configured allowances are not measured usage" };
}
public flow historical_stage(name: string, state: Ledger) -> unit {
    progress("STAGE " + name);
    progress(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
}
public flow expanded_stage(name: string, state: Ledger, wide: bool) -> unit {
    progress("STAGE " + name);
    progress(expanded_ledger_text(state, wide));
}
public flow chain_stage(name: string, state: Ledger, user_context: bool) -> unit {
    progress("STAGE " + name);
    progress(historical_ledger_text(state) + if user_context {
        "; per-turn configured allowances are not measured usage; user-context work cannot continue or resume"
    } else {
        "; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation"
    });
}

flow unicode_read(request: string, allowed: Array<string>, state: ReadLedger, expanded: bool, wide: bool) -> Result<ReadReport, ReadFailure> {
    let result = if expanded { run_expanded_context(request, allowed, state, wide) } else { unicode_read_context(request, allowed, state, "read-", true, false, false, false) };
    return match result {
        Ok(value) => Ok(ReadReport { request = value.request, task = value.task, allowed = value.allowed, child = value.child,
            status = value.status, observed = value.observed, answer = value.answer, ledger = value.ledger }),
        Err(error) => Err(ReadFailure { state = error.state, error = error.error, resolved = error.resolved }),
    };
}

flow prepare_policy<P ~ WorkBudgetPolicy>(policy: P, input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write], chain_read: bool, inspect_plan: bool, inspect_all: bool, unicode: bool) -> Result<Pending, Failure> {
    let parameters = policy.parameters();
    let expanded = parameters.expanded; let wide = parameters.large;
    var state = fresh();
    let maximum = policy.maximum();
    let selected = input.selected;
    let invalid = ledger_error(state); if invalid != "" { return failed(state, invalid); }
    progress(if wide { "RESERVATION work" + to_string_i32(maximum.steps) + " steps/" + to_string_i32(maximum.calls) + " calls/" + to_string_i32(maximum.generation) + " generation/" + to_string_i32(maximum.native_tokens) + " native; edit tail6 steps/3 calls/143360 generation/1524288 native; one read/search up to 65540 bytes, three edit reads up to 65537 bytes each, and one atomic maximum" } else { if expanded { "RESERVATION work13 steps/7 calls/51200 generation/1335296 native; edit tail6 steps/3 calls/38912 generation/786432 native; one read/search up to 65540 bytes, three edit reads up to 65537 bytes each, and one atomic maximum" } else { "RESERVATION work13 steps/7 calls/47104 generation/196608 historical native allowance (not a provider cap); edit tail6 steps/3 calls/38912 generation/163840 historical allowance; one read/search and one atomic maximum" } });
    let read_result = if unicode { unicode_read(input.request, input.allowed, state.read, expanded, wide) }
        else { read_context(input.request, input.allowed, state.read, "read-", true, chain_read, inspect_plan, inspect_all) };
    let read = match read_result {
        Ok(value) => value,
        Err(failure) => {
            state = Ledger { read = failure.state, edit = state.edit };
            if !failure.resolved { progress("RESERVATION read unresolved; no subsequent edit work"); }
            return failed(state, failure.error);
        }
    };
    state = Ledger { read = read.ledger, edit = state.edit };
    let pending = match collect(read.child, read.status, read.request, read.task, read.allowed, wide) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let evidence = match finish_evidence(pending, read.answer) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    if evidence.ledger.steps != read.ledger.steps || evidence.ledger.calls != read.ledger.calls || evidence.ledger.tokens != read.ledger.tokens ||
        evidence.ledger.tools != read.ledger.tools || evidence.ledger.scan != read.ledger.scan { return failed(state, "read evidence ledger mismatch"); }
    let before = match perform EditOriginal.read(selected.path) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let original = original_error(before); if original != "" { return failed(state, original); }
    let plan = Context { edit = context("plan", selected, input.request, "", before), evidence = evidence };
    let error = context_error(plan); if error != "" { return failed(state, error); }
    state = match policy.reserve_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-plan", state);
    let plan_raw = perform LegacyEditStages.plan(plan);
    if inspect_all { diagnostic(response_text(plan_raw, "edit-plan", "lab-qwen-", 4096)); }
    let decoded_plan = if chain_read { decode_work_plan(plan_raw) } else { decode_plan(plan_raw) };
    let task = match decoded_plan { Ok(value) => value, Err(error) => { return failed(state, error); } };
    state = match policy.reserve_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    display("EVENT main -> edit-child request ", task);
    let delegated = Context { edit = context("child", selected, input.request, task, before), evidence = evidence };
    let child_error = context_error(delegated); if child_error != "" { return failed(state, child_error); }
    state = match policy.reserve_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-child", state);
    let edit_raw = perform LegacyEditStages.child(delegated);
    if inspect_all { diagnostic(response_text(edit_raw, "edit-child", "lab-qwen-", 32768)); }
    let decoded_edit = if expanded && before == "" { decode_empty_edit(edit_raw) } else { if chain_read { decode_work_edit(edit_raw) } else { decode_edit(edit_raw) } };
    let request = match decoded_edit { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let prepared = match (if expanded { prepare_original(selected.path, before, request.target, request.replacement) } else { prepare_original_legacy(selected.path, before, request.target, request.replacement) }) { Ok(value) => value, Err(error) => { return failed(state, if chain_read { response_error(edit_raw, "edit-child", "proposal", 32768) } else { error }); } };
    state = match policy.reserve_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    return Ok(Pending { selected = selected, prepared = prepared, evidence = evidence, request = input.request, task = task, state = state });
}

flow prepare_mode(input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write], chain_read: bool, inspect_plan: bool, inspect_all: bool, unicode: bool, expanded: bool, wide: bool) -> Result<Pending, Failure> {
    if wide { return prepare_policy(LargeWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode); }
    if expanded { return prepare_policy(ExpandedWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode); }
    return prepare_policy(HistoricalWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode);
}

public flow prepare_with(input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write], chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_mode(input, original_error, stage_log, chain_read, inspect_plan, inspect_all, false, false, false);
}
public flow prepare_unicode(input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write]) -> Result<Pending, Failure> {
    return prepare_mode(input, original_error, stage_log, false, false, false, true, false, false);
}
public flow prepare_expanded_unicode(input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write], wide: bool) -> Result<Pending, Failure> {
    return prepare_mode(input, original_error, stage_log, false, false, false, true, true, wide);
}
public flow prepare_chain(input: WorkRequest, original_error: (string) -> string ![], stage_log: (string, Ledger) -> unit ![HarnessProgress.write], inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_mode(input, original_error, stage_log, true, inspect_plan, inspect_all, false, false, false);
}

public flow complete(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    let state = match bump_edit(pending.state, false) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = pending.state, error = "edit completed; " + error }); } };
    let final = Context { edit = completed_context(pending.request, pending.task, pending.prepared.proposal.before, outcome), evidence = pending.evidence };
    let error = context_error(final); if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Completed { context = final, state = state });
}

flow finish_mode(completed: Completed, stage_log: (string, Ledger) -> unit ![HarnessProgress.write], work: bool, inspect_all: bool, history: bool) -> Result<Summary, Failure> {
    let state = match bump_edit(completed.state, true) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = completed.state, error = "edit completed; " + error }); } };
    stage_log("edit-aggregate", state);
    let answer = perform LegacyEditStages.aggregate(completed.context);
    if inspect_all { diagnostic(response_text(answer, "edit-aggregate", "lab-qwen-", 512)); }
    let error = if history { history_summary_error(answer, "final answer") } else { if work { work_summary_error(answer) } else { text_error(answer, "final answer") } };
    if history && error == "final answer requires 1..1024 nonblank UTF-8 bytes" {
        progress("MODEL SUMMARY unavailable: blank or over limit; the edit was already confirmed. A factual fallback will be recorded.");
        return Ok(Summary { answer = history_fallback_summary(), state = state, model_generated = false });
    }
    if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Summary { answer = answer, state = state, model_generated = true });
}

public flow finish_summary(completed: Completed, stage_log: (string, Ledger) -> unit ![HarnessProgress.write], work: bool, inspect_all: bool) -> Result<Summary, Failure> {
    return finish_mode(completed, stage_log, work, inspect_all, false);
}
public flow finish_history_summary(completed: Completed, stage_log: (string, Ledger) -> unit ![HarnessProgress.write]) -> Result<Summary, Failure> {
    return finish_mode(completed, stage_log, false, false, true);
}
