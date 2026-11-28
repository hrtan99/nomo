module nomo.domain.harness.work;

import nomo.domain.harness.edit.{
    Context as edit_Context,
    bump_mode,
    context_error as edit_context_error,
    fresh as edit_fresh,
    large_error,
    ledger_error as edit_ledger_error,
    wide_error
};
import nomo.domain.harness.loop.{Session, allowed_error};
import nomo.domain.harness.read.{
    decode_child,
    high_input_bump,
    high_input_error,
    high_input_settle,
    inspect_work,
    read_fresh,
    wide_bump,
    work_bump,
    work_error,
    work_settle
};
import nomo.domain.limits.{child_answer_bytes, compatible_scan_i32, context_bytes, message_bytes, outcome_bytes};
import nomo.domain.text.bounded;
import nomo.domain.wire.{encode, json};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.harness_work_contract.Ledger as harness_work_contract_Ledger;
import std.text.{len, starts_with};

public type Evidence = { request: string, task: string, operation: string, files: Array<string>, literal: string,
    outcome: string, result: string, summary: string, allowed: Array<string>, ledger: Ledger };

public type Context = { edit: edit_Context, evidence: Evidence };

public type WorkMaximum = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };

public type WorkParameters = { expanded: bool, wide: bool, large: bool, high_input: bool };

public spec WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![];
    flow parameters(self) -> WorkParameters ![];
    flow reserve_edit(self, state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> ![];
}

public type HistoricalWorkBudget = {};

public type ExpandedWorkBudget = {};

public type LargeWorkBudget = {};

public type HighInputWorkBudget = {};

impl HistoricalWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = false, wide = false, large = false, high_input = false }; }
    flow reserve_edit(self, state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> ![] { return bump_selected(state, call, false, false); }
}

impl ExpandedWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 51200, native_tokens = 1335296 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = false, large = false, high_input = false }; }
    flow reserve_edit(self, state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> ![] { return bump_selected(state, call, false, false); }
}

impl LargeWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 286720, native_tokens = 2811008 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = true, large = true, high_input = false }; }
    flow reserve_edit(self, state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> ![] { return bump_selected(state, call, true, true); }
}

impl HighInputWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 917504, native_tokens = 7340032 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = true, large = false, high_input = true }; }
    flow reserve_edit(self, state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> ![] { return bump_selected(state, call, true, false); }
}

public flow fresh() -> harness_work_contract_Ledger { return harness_work_contract_Ledger { read = read_fresh(), edit = edit_fresh() }; }

flow read_complete(value: Ledger) -> bool {
    return value.steps == 7 && value.calls == 4 && (value.tokens == 8192 || value.tokens == 12288 || value.tokens == 16384 || value.tokens == 20480 || value.tokens == 143360 || value.tokens == 524288) && value.tools == 1 && (value.scan == 4096 || value.scan == 16384 || value.scan == 65540 || compatible_scan_i32(value.scan));
}

flow selected_edit_error(state: harness_work_contract_Ledger) -> string {
    if state.read.tokens == 143360 && wide_error(state.edit) != "" { return large_error(state.edit); }
    return if state.read.tokens == 16384 || state.read.tokens == 20480 || state.read.tokens == 143360 || state.read.tokens == 524288 { wide_error(state.edit) } else { edit_ledger_error(state.edit) };
}

// Historical ledger allowance; it is not the interpreter total-token cap.
public flow native_tokens(state: harness_work_contract_Ledger) -> i32 {
    if (work_error(state.read) != "" && high_input_error(state.read) != "") || selected_edit_error(state) != "" { return 0; }
    return state.read.calls * 8192 + state.edit.native_tokens;
}

// New event-work stages reserve interpreter-enforced total-token maxima.
public flow native_budget(state: harness_work_contract_Ledger) -> i32 {
    if state.read.tokens == 131072 || state.read.tokens == 393216 || state.read.tokens == 524288 { return (state.read.calls + state.edit.calls) * 1048576; }
    let read = match state.read.calls { 0 => 0, 1 => 8192, 2 => 24576, 3 => 286720, _ => 548864 };
    return read + state.edit.calls * 262144 + (if state.read.tokens >= 139264 { 737856 } else { 0 }) + (if state.read.tokens == 143360 && state.edit.tokens >= 139264 { 737856 } else { 0 });
}

public flow ledger_error(state: harness_work_contract_Ledger) -> string {
    let read = work_error(state.read); if read != "" { let high = high_input_error(state.read); if high != "" { return read; } }
    let edit = selected_edit_error(state); if edit != "" { return edit; }
    if state.edit.steps != 0 && !read_complete(state.read) { return "edit tail requires settled read work"; }
    let high_input = state.read.tokens == 131072 || state.read.tokens == 393216 || state.read.tokens == 524288;
    if state.read.steps + state.edit.steps > 13 || state.read.calls + state.edit.calls > 7 ||
        state.read.tokens + state.edit.tokens > if high_input { 917504 } else { 286720 } || native_tokens(state) > 196608 || native_budget(state) > if high_input { 7340032 } else { 2811008 } {
        return "shared work reservation exhausted";
    }
    return "";
}

// Both reservations are created once, before any Model/File work. The read
// ledger remains in this value while the existing edit ledger advances.
flow bump_selected(state: harness_work_contract_Ledger, call: bool, wide: bool, large: bool) -> Result<harness_work_contract_Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if !read_complete(state.read) { return Err("edit tail requires settled read work"); }
    let edit = match bump_mode(state.edit, call, wide, large) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(state { edit });
}

// Compatibility selection for a settled historical ledger. Current preparation
// receives its policy before any work and never infers it from running counters.
public flow bump_edit(state: harness_work_contract_Ledger, call: bool) -> Result<harness_work_contract_Ledger, string> {
    if state.read.tokens == 143360 { let policy = LargeWorkBudget {}; return policy.reserve_edit(state, call); }
    if state.read.tokens == 16384 || state.read.tokens == 20480 { return bump_selected(state, call, true, false); }
    let policy = HistoricalWorkBudget {}; return policy.reserve_edit(state, call);
}

public flow bump_edit_mode(state: harness_work_contract_Ledger, call: bool, high_input: bool) -> Result<harness_work_contract_Ledger, string> {
    if high_input { let policy = HighInputWorkBudget {}; return policy.reserve_edit(state, call); }
    return bump_edit(state, call);
}

flow selected_error(value: Evidence, complete: bool) -> string {
    if !bounded(value.request, message_bytes()) || !bounded(value.task, message_bytes()) || !bounded(value.result, child_answer_bytes()) ||
        !bounded(value.outcome, outcome_bytes()) || !starts_with(value.outcome, "complete: ") { return "invalid read evidence text"; }
    let allowed = allowed_error(value.allowed); if allowed != "" { return allowed; }
    let files = allowed_error(value.files); if files != "" { return files; }
    var fields: Array<string> = [];
    if value.operation == "read" && value.files.len() == 1 && value.literal == "" { fields = ["read", value.files[0]]; }
    else if value.operation == "search" {
        fields = ["search", value.literal, value.files[0]];
        if value.files.len() >= 2 { fields = fields.push(value.files[1]); }
        if value.files.len() >= 3 { fields = fields.push(value.files[2]); }
        if value.files.len() >= 4 { fields = fields.push(value.files[3]); }
    } else { return "read evidence requires a read or search"; }
    let raw = match json(fields) { Ok(item) => item, Err(error) => { return error; } };
    match decode_child(raw, value.allowed, false) { Ok(_) => (), Err(error) => { return error; } }
    let invalid = work_error(value.ledger); if invalid != "" {
        let high_input = high_input_error(value.ledger); if high_input != "" { return invalid; }
    }
    if complete {
        if !read_complete(value.ledger) || !bounded(value.summary, message_bytes()) { return "read evidence is not settled"; }
    } else if value.summary != "" || value.ledger.steps != 5 || value.ledger.calls != 3 || (value.ledger.tokens != 6144 && value.ledger.tokens != 10240 && value.ledger.tokens != 12288 && value.ledger.tokens != 16384 && value.ledger.tokens != 139264 && value.ledger.tokens != 393216) ||
        value.ledger.tools != 1 || (value.ledger.scan != 4096 && value.ledger.scan != 16384 && value.ledger.scan != 65540 && !compatible_scan_i32(value.ledger.scan)) { return "invalid pending read evidence"; }
    return "";
}

public flow evidence_error(value: Evidence) -> string { return selected_error(value, true); }

// Admit only the ordinary, source-constructed successful tool-child shape.
// A direct final answer cannot substitute for an actual complete tool outcome.
public flow collect(child: Session, status: i32, request: string, task: string, allowed: Array<string>, wide: bool, high_input: bool) -> Result<Evidence, string> {
    let observed = match inspect_work(child, status, request, task, allowed) { Ok(value) => value, Err(error) => { return Err(error); } };
    if status != 0 || (observed.tool != "read" && observed.tool != "search") { return Err("work requires a successful read or search child"); }
    let selected = match decode_child(child.history.events[3].text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
    let reserved = Ledger { steps = 2, calls = 1, tokens = if high_input { 131072 } else { if wide { 4096 } else { 2048 } }, tools = 0, scan = 0 };
    let ledger = match if high_input { high_input_settle(reserved, child) } else { work_settle(reserved, child) } { Ok(value) => value, Err(error) => { return Err(error); } };
    let evidence = Evidence { request, task, operation = selected.operation, files = selected.files,
        literal = selected.literal, outcome = observed.outcome, result = observed.result, summary = "", allowed, ledger };
    let invalid = selected_error(evidence, false); if invalid != "" { return Err(invalid); }
    return Ok(evidence);
}

// The controller separately precharges these two stages before its summary
// Model call, then compares the returned ledger with its invocation ledger.
public flow finish_evidence(value: Evidence, summary: string) -> Result<Evidence, string> {
    let invalid = selected_error(value, false); if invalid != "" { return Err(invalid); }
    let high_input = value.ledger.tokens == 393216;
    let wide = value.ledger.tokens == 12288 || value.ledger.tokens == 16384 || value.ledger.tokens == 139264;
    let consumed = match if high_input { high_input_bump(value.ledger, false) } else { if wide { wide_bump(value.ledger, false) } else { work_bump(value.ledger, false) } } { Ok(item) => item, Err(error) => { return Err(error); } };
    let ledger = match if high_input { high_input_bump(consumed, true) } else { if wide { wide_bump(consumed, true) } else { work_bump(consumed, true) } } { Ok(item) => item, Err(error) => { return Err(error); } };
    let result = value { summary, ledger };
    let error = evidence_error(result); if error != "" { return Err(error); }
    return Ok(result);
}

public flow context_error(value: Context) -> string {
    let evidence = evidence_error(value.evidence); if evidence != "" { return evidence; }
    let edit = edit_context_error(value.edit); if edit != "" { return edit; }
    if value.edit.request != value.evidence.request { return "read and edit original request changed"; }
    let encoded = match encode(value, "work context conversion refused", "work context JSON refused") { Ok(value) => value, Err(error) => { return error; } };
    if len(encoded) > context_bytes() { return "work context exceeds 33554432 serialized UTF-8 bytes"; }
    return "";
}
