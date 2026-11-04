module nomo.entry.harness_work_entry;

public import nomo.application.work_contract.{Failure, Pending, Completed, Summary};

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.text.to_string_i32;
import nomo.harness.model_plan_diagnostic.{response_error, response_text};
import nomo.cli.harness_work_args.{Work, parse};
import nomo.harness.harness_work_contract.{Context, Ledger, WorkBudgetPolicy, HistoricalWorkBudget, ExpandedWorkBudget, LargeWorkBudget, fresh, ledger_error, bump_edit, native_tokens, native_budget, collect, finish_evidence, context_error};
import nomo.harness.harness_model_tools.{run_context as read_context, work_child_turn, chain_child_turn, Report as ReadReport, Failure as ReadFailure};
import nomo.harness.read_model_tools.{run_context as unicode_read_context, run_expanded_context};
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.edit_original.EditOriginal;
import nomo.harness.harness_work_model.{read_main, edit_plan, edit_child, aggregate};
import nomo.harness.work_chain_context.ParentFacts;
import nomo.harness.work_chain_model.{plan as chain_plan, child as chain_child, aggregate as chain_aggregate};
import nomo.harness.harness_edit_contract.{decode_plan, decode_edit, decode_empty_edit, text_error, history_summary_error, history_fallback_summary, decode_work_plan, decode_work_edit, work_summary_error};
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.{EditableRoot, read_original, read_original_wide, prepare_original, prepare_original_legacy};
import nomo.session.edit_operation_store.available;
import nomo.entry.edit_coordinator.{Approval, Selector, Confirmed, execute};
import nomo.harness.edit_context.{context, completed_context};
import nomo.entry.edit_context.{recorded, display};

flow ledger_text(state: Ledger) -> string {
    return "LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" +
        to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) +
        "/47104 historical_native_allowance=" + to_string_i32(native_tokens(state)) + "/196608";
}
public flow ledger(state: Ledger) -> unit { println(ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume"); }
public flow chain_ledger(state: Ledger) -> unit { println(ledger_text(state) + "; per-turn configured allowances are not measured usage; bounded v2 continuation requires a fresh durable claim and current confirmation"); }
public flow user_context_ledger(state: Ledger) -> unit { println(ledger_text(state) + "; per-turn configured allowances are not measured usage; user-context work cannot continue or resume"); }
flow chain_stage(name: string, state: Ledger, user_context: bool) -> unit {
    println("STAGE " + name);
    if user_context { user_context_ledger(state); } else { chain_ledger(state); }
}

public flow refused(state: Ledger, error: string) -> i32 { println("REFUSED " + error); ledger(state); return 1; }
flow stage(name: string, state: Ledger) -> unit { println("STAGE " + name); ledger(state); }
flow help() -> unit {
    println("One read-context/edit workflow: --id ID --workspace BIND --path EDITFILE --once TASK --allow FILE[,FILE].");
    println("Overall request/read task1..128 printable ASCII;1..2 read paths<=48 characters, raw allow<=97; complete read context<=2048 serialized characters.");
    println("One read/search,16384 scan allowance; complete display result<=65536 UTF-8 bytes, search yields locations. Edit original/result<=16384 UTF-8 bytes, whole edit/read data<=262144 bytes.");
    println("Maximum13 steps /7 Model calls /47104 generation /196608 historical native allowance (not a provider token cap) /3 edit reads with6144-byte allowance /1 atomic attempt. Edit tail reserved before read.");
    println("Exclusive owned disposable workspace/store; native yes then Nomo y/yes. Data-only edit_status, no automatic retries or mutating resume.");
}

flow failed(state: Ledger, error: string) -> Result<Pending, Failure> { return Err(Failure { state = state, error = error }); }

flow unicode_read(request: string, allowed: Array<string>, state: ReadLedger, expanded: bool, wide: bool) -> Result<ReadReport, ReadFailure> {
    let result = if expanded { run_expanded_context(request, allowed, state, wide) } else { unicode_read_context(request, allowed, state, "read-", true, false, false, false) };
    return match result {
        Ok(value) => Ok(ReadReport { request = value.request, task = value.task, allowed = value.allowed, child = value.child,
            status = value.status, observed = value.observed, answer = value.answer, ledger = value.ledger }),
        Err(error) => Err(ReadFailure { state = error.state, error = error.error, resolved = error.resolved }),
    };
}

// Callers admit the unused edit slot before this shared Model/File preparation.
flow prepare_policy<P ~ WorkBudgetPolicy>(policy: P, input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, chain_read: bool, inspect_plan: bool, inspect_all: bool, unicode: bool) -> Result<Pending, Failure> {
    let parameters = policy.parameters();
    let expanded = parameters.expanded; let wide = parameters.large;
    var state = fresh();
    let maximum = policy.maximum();
    let selected = Selector { id = input.edit.id, workspace = input.edit.workspace, path = input.edit.path };
    let invalid = ledger_error(state); if invalid != "" { return failed(state, invalid); }
    println(if wide { "RESERVATION work" + to_string_i32(maximum.steps) + " steps/" + to_string_i32(maximum.calls) + " calls/" + to_string_i32(maximum.generation) + " generation/" + to_string_i32(maximum.native_tokens) + " native; edit tail6 steps/3 calls/143360 generation/1524288 native; one read/search up to 65540 bytes, three edit reads up to 65537 bytes each, and one atomic maximum" } else { if expanded { "RESERVATION work13 steps/7 calls/51200 generation/1335296 native; edit tail6 steps/3 calls/38912 generation/786432 native; one read/search up to 65540 bytes, three edit reads up to 65537 bytes each, and one atomic maximum" } else { "RESERVATION work13 steps/7 calls/47104 generation/196608 historical native allowance (not a provider cap); edit tail6 steps/3 calls/38912 generation/163840 historical allowance; one read/search and one atomic maximum" } });
    let read_result = if unicode { unicode_read(input.edit.request, input.allowed, state.read, expanded, wide) }
        else { read_context(input.edit.request, input.allowed, state.read, "read-", true, chain_read, inspect_plan, inspect_all) };
    let read = match read_result {
        Ok(value) => value,
        Err(failure) => {
            state = Ledger { read = failure.state, edit = state.edit };
            if !failure.resolved { println("RESERVATION read unresolved; no subsequent edit work"); }
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
    let plan = Context { edit = context("plan", selected, input.edit.request, "", before), evidence = evidence };
    let error = context_error(plan); if error != "" { return failed(state, error); }
    state = match policy.reserve_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-plan", state);
    let plan_raw = perform LegacyEditStages.plan(plan);
    if inspect_all { println(response_text(plan_raw, "edit-plan", "lab-qwen-", 4096)); }
    let decoded_plan = if chain_read { decode_work_plan(plan_raw) } else { decode_plan(plan_raw) };
    let task = match decoded_plan { Ok(value) => value, Err(error) => { return failed(state, error); } };
    state = match policy.reserve_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    display("EVENT main -> edit-child request ", task);
    let delegated = Context { edit = context("child", selected, input.edit.request, task, before), evidence = evidence };
    let child_error = context_error(delegated); if child_error != "" { return failed(state, child_error); }
    state = match policy.reserve_edit(state, true) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    stage_log("edit-child", state);
    let edit_raw = perform LegacyEditStages.child(delegated);
    if inspect_all { println(response_text(edit_raw, "edit-child", "lab-qwen-", 32768)); }
    let decoded_edit = if expanded && before == "" { decode_empty_edit(edit_raw) } else { if chain_read { decode_work_edit(edit_raw) } else { decode_edit(edit_raw) } };
    let request = match decoded_edit { Ok(value) => value, Err(error) => { return failed(state, error); } };
    let prepared = match (if expanded { prepare_original(selected.path, before, request.target, request.replacement) } else { prepare_original_legacy(selected.path, before, request.target, request.replacement) }) { Ok(value) => value, Err(error) => { return failed(state, if chain_read { response_error(edit_raw, "edit-child", "proposal", 32768) } else { error }); } };
    state = match policy.reserve_edit(state, false) { Ok(value) => value, Err(error) => { return failed(state, error); } };
    return Ok(Pending { selected = selected, prepared = prepared, evidence = evidence, request = input.edit.request, task = task, state = state });
}

flow prepare_mode_with(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, chain_read: bool, inspect_plan: bool, inspect_all: bool, unicode: bool, expanded: bool, wide: bool) -> Result<Pending, Failure> {
    if wide { return prepare_policy(LargeWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode); }
    if expanded { return prepare_policy(ExpandedWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode); }
    return prepare_policy(HistoricalWorkBudget {}, input, original_error, stage_log, chain_read, inspect_plan, inspect_all, unicode);
}

public flow prepare_with(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_mode_with(input, original_error, stage_log, chain_read, inspect_plan, inspect_all, false, false, false);
}

public flow prepare_unicode(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit) -> Result<Pending, Failure> {
    return prepare_mode_with(input, original_error, stage_log, false, false, false, true, false, false) with {
        EditOriginal.read(path) => { resume read_original(path); }
    };
}

public flow prepare_expanded_unicode(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, wide: bool) -> Result<Pending, Failure> {
    return prepare_mode_with(input, original_error, stage_log, false, false, false, true, true, wide) with {
        EditOriginal.read(path) => { resume read_original_wide(path); }
    };
}
public flow expanded_stage(name: string, state: Ledger, wide: bool) -> unit { println("STAGE " + name); expanded_ledger(state, wide); }
public flow simple_refused(error: string) -> i32 { println("REFUSED " + error); return 1; }
public flow expanded_ledger(state: Ledger, wide: bool) -> unit {
    println("LEDGER work steps=" + to_string_i32(state.read.steps + state.edit.steps) + "/13 calls=" + to_string_i32(state.read.calls + state.edit.calls) + "/7 generation_allowance=" + to_string_i32(state.read.tokens + state.edit.tokens) + (if wide { "/286720 native_configured=" } else { "/51200 native_configured=" }) + to_string_i32(native_budget(state)) + if wide { "/2811008; configured allowances are not measured usage" } else { "/1335296; configured allowances are not measured usage" });
}

// The production facade binds the original native reader once; exceptions and
// the caller-supplied original validation remain at their original boundary.
public flow prepare(input: Work, original_error: (string) -> string, stage_log: (string, Ledger) -> unit, chain_read: bool, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_with(input, original_error, stage_log, chain_read, inspect_plan, inspect_all) with {
        EditOriginal.read(path) => { resume read_original(path); }
    };
}

public flow prepare_work(input: Work) -> Result<Pending, Failure> {
    let original = (value: string) => "";
    let log = (name: string, state: Ledger) => stage(name, state);
    return prepare(input, original, log, false, false, false) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume work_child_turn(task, files, selected); }
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}
flow prepare_chain_mode(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool, user_context: bool) -> Result<Pending, Failure> {
    let original = (value: string) => match expected { Some(before) => if value == before { "" } else { "current original differs from confirmed parent result" }, None() => "" };
    let log = (name: string, state: Ledger) => chain_stage(name, state, user_context);
    return prepare(input, original, log, true, inspect_plan, inspect_all) with {
        LegacyStringStages.main(value) => { resume read_main(value); }
        LegacyStringStages.child(task, files, selected) => { resume chain_child_turn(task, files, selected, inspect_all); }
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}


public flow prepare_chain_work(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, false);
}
public flow prepare_user_context_work(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_chain_mode(input, parent, expected, inspect_plan, inspect_all, true);
}

public flow completed_context_work(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    let state = match bump_edit(pending.state, false) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = pending.state, error = "edit completed; " + error }); } };
    let final = Context { edit = completed_context(pending.request, pending.task, pending.prepared.proposal.before, outcome), evidence = pending.evidence };
    let error = context_error(final); if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Completed { context = final, state = state });
}

public flow finish_edit(pending: Pending, outcome: Confirmed) -> Result<Completed, Failure> {
    recorded(pending.selected); return completed_context_work(pending, outcome);
}

flow finish_summary_mode(completed: Completed, stage_log: (string, Ledger) -> unit, work: bool, inspect_all: bool, history: bool) -> Result<Summary, Failure> {
    let state = match bump_edit(completed.state, true) { Ok(value) => value,
        Err(error) => { return Err(Failure { state = completed.state, error = "edit completed; " + error }); } };
    stage_log("edit-aggregate", state);
    let answer = perform LegacyEditStages.aggregate(completed.context);
    if inspect_all { println(response_text(answer, "edit-aggregate", "lab-qwen-", 512)); }
    let error = if history { history_summary_error(answer, "final answer") } else { if work { work_summary_error(answer) } else { text_error(answer, "final answer") } };
    if history && error == "final answer requires 1..1024 nonblank UTF-8 bytes" {
        println("MODEL SUMMARY unavailable: blank or over limit; the edit was already confirmed. A factual fallback will be recorded.");
        return Ok(Summary { answer = history_fallback_summary(), state = state, model_generated = false });
    }
    if error != "" { return Err(Failure { state = state, error = "edit completed; " + error }); }
    return Ok(Summary { answer = answer, state = state, model_generated = true });
}
public flow finish_summary(completed: Completed, stage_log: (string, Ledger) -> unit, work: bool, inspect_all: bool) -> Result<Summary, Failure> {
    return finish_summary_mode(completed, stage_log, work, inspect_all, false);
}
public flow finish_history_summary(completed: Completed, stage_log: (string, Ledger) -> unit) -> Result<Summary, Failure> {
    return finish_summary_mode(completed, stage_log, false, false, true);
}

public flow summarize(completed: Completed) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => stage(name, state);
    return finish_summary(completed, log, false, false) with {
        LegacyEditStages.plan(value) => { resume edit_plan(value); }
        LegacyEditStages.child(value) => { resume edit_child(value); }
        LegacyEditStages.aggregate(value) => { resume aggregate(value); }
    };
}
flow summarize_chain_mode(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool, user_context: bool) -> Result<Summary, Failure> {
    let log = (name: string, state: Ledger) => chain_stage(name, state, user_context);
    return finish_summary(completed, log, true, inspect_all) with {
        LegacyEditStages.plan(value) => { resume chain_plan(value, parent); }
        LegacyEditStages.child(value) => { resume chain_child(value, parent); }
        LegacyEditStages.aggregate(value) => { resume chain_aggregate(value, parent); }
    };
}


public flow summarize_chain(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    return summarize_chain_mode(completed, parent, inspect_all, false);
}
public flow summarize_user_context(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    return summarize_chain_mode(completed, parent, inspect_all, true);
}

public flow run(args: Array<string>) -> i32 ![Console, Memory, Approval, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let input = match parse(args) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if input.edit.help { help(); return 0; }
    match available() { Ok(_) => {} Err(error) => { return refused(fresh(), error); } }
    let pending = match prepare_work(input) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let outcome = match execute(pending.selected, pending.prepared) { Ok(value) => value, Err(error) => { return refused(pending.state, error); } };
    let completed = match finish_edit(pending, outcome) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    let summary = match summarize(completed) { Ok(value) => value, Err(failure) => { return refused(failure.state, failure.error); } };
    display("FINAL ", summary.answer); ledger(summary.state); return 0;
}
