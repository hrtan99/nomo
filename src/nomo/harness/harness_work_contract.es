module nomo.harness.harness_work_contract;

import nomo.core.json.encode as encode_json;

import std.text.starts_with;
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;


import nomo.model.model_tool_contract.{Session, allowed_error};
import nomo.model.read_protocol.decode_child as decode_reply;
import nomo.core.read_text.bounded;
import nomo.harness.read_tool_contract.inspect_work as inspect;
import nomo.harness.harness_tool_contract.work_settle as settle;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_tool_contract.fresh as read_fresh;
import nomo.harness.harness_tool_contract.{wide_bump, work_bump as read_bump};
import nomo.harness.harness_tool_contract.work_error as read_error;
import nomo.harness.harness_edit_contract.Context as EditContext;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;
import nomo.harness.harness_edit_contract.fresh as edit_fresh;
import nomo.harness.harness_edit_contract.bump_mode as edit_bump;
import nomo.harness.harness_edit_contract.{ledger_error as edit_error, wide_error, large_error};
import nomo.harness.harness_edit_contract.context_error as edit_context_error;
import nomo.tools.edit_encoding.json;
import nomo.core.large_context.{scan_i32, outcome_bytes, child_answer_bytes};

public type Evidence = { request: string, task: string, operation: string, files: Array<string>, literal: string,
    outcome: string, result: string, summary: string, allowed: Array<string>, ledger: ReadLedger };
public type Context = { edit: EditContext, evidence: Evidence };
public type Ledger = { read: ReadLedger, edit: EditLedger };

public type WorkMaximum = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };
public type WorkParameters = { expanded: bool, wide: bool, large: bool, high_input: bool };
public spec WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![];
    flow parameters(self) -> WorkParameters ![];
    flow reserve_edit(self, state: Ledger, call: bool) -> Result<Ledger, string> ![];
}
public type HistoricalWorkBudget = {};
public type ExpandedWorkBudget = {};
public type LargeWorkBudget = {};
public type HighInputWorkBudget = {};
impl HistoricalWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = false, wide = false, large = false, high_input = false }; }
    flow reserve_edit(self, state: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump_selected(state, call, false, false); }
}
impl ExpandedWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 51200, native_tokens = 1335296 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = false, large = false, high_input = false }; }
    flow reserve_edit(self, state: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump_selected(state, call, false, false); }
}
impl LargeWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 286720, native_tokens = 2811008 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = true, large = true, high_input = false }; }
    flow reserve_edit(self, state: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump_selected(state, call, true, true); }
}
impl HighInputWorkBudget ~ WorkBudgetPolicy {
    flow maximum(self) -> WorkMaximum ![] { return WorkMaximum { steps = 13, calls = 7, generation = 188416, native_tokens = 6000000 }; }
    flow parameters(self) -> WorkParameters ![] { return WorkParameters { expanded = true, wide = true, large = false, high_input = true }; }
    flow reserve_edit(self, state: Ledger, call: bool) -> Result<Ledger, string> ![] { return bump_selected(state, call, true, false); }
}

public flow fresh() -> Ledger { return Ledger { read = read_fresh(), edit = edit_fresh() }; }

flow read_complete(value: ReadLedger) -> bool {
    return value.steps == 7 && value.calls == 4 && (value.tokens == 8192 || value.tokens == 12288 || value.tokens == 16384 || value.tokens == 20480 || value.tokens == 143360) && value.tools == 1 && (value.scan == 4096 || value.scan == 16384 || value.scan == 65540 || value.scan == scan_i32());
}

flow selected_edit_error(state: Ledger) -> string {
    if state.read.tokens == 143360 && wide_error(state.edit) != "" { return large_error(state.edit); }
    return if state.read.tokens == 16384 || state.read.tokens == 20480 || state.read.tokens == 143360 { wide_error(state.edit) } else { edit_error(state.edit) };
}

// Historical ledger allowance; it is not the interpreter total-token cap.
public flow native_tokens(state: Ledger) -> i32 {
    if read_error(state.read) != "" || selected_edit_error(state) != "" { return 0; }
    return state.read.calls * 8192 + state.edit.native_tokens;
}

// New event-work stages reserve interpreter-enforced total-token maxima.
public flow native_budget(state: Ledger) -> i32 {
    let read = match state.read.calls { 0 => 0, 1 => 8192, 2 => 24576, 3 => 286720, _ => 548864 };
    return read + state.edit.calls * 262144 + (if state.read.tokens >= 139264 { 737856 } else { 0 }) + (if state.read.tokens == 143360 && state.edit.tokens >= 139264 { 737856 } else { 0 });
}

public flow ledger_error(state: Ledger) -> string {
    let read = read_error(state.read); if read != "" { return read; }
    let edit = selected_edit_error(state); if edit != "" { return edit; }
    if state.edit.steps != 0 && !read_complete(state.read) { return "edit tail requires settled read work"; }
    if state.read.steps + state.edit.steps > 13 || state.read.calls + state.edit.calls > 7 ||
        state.read.tokens + state.edit.tokens > 286720 || native_tokens(state) > 196608 || native_budget(state) > 2811008 {
        return "shared work reservation exhausted";
    }
    return "";
}

// Both reservations are created once, before any Model/File work. The read
// ledger remains in this value while the existing edit ledger advances.
flow bump_selected(state: Ledger, call: bool, wide: bool, large: bool) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if !read_complete(state.read) { return Err("edit tail requires settled read work"); }
    let edit = match edit_bump(state.edit, call, wide, large) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ledger { read = state.read, edit = edit });
}
// Compatibility selection for a settled historical ledger. Current preparation
// receives its policy before any work and never infers it from running counters.
public flow bump_edit(state: Ledger, call: bool) -> Result<Ledger, string> {
    if state.read.tokens == 143360 { let policy = LargeWorkBudget {}; return policy.reserve_edit(state, call); }
    if state.read.tokens == 16384 || state.read.tokens == 20480 { return bump_selected(state, call, true, false); }
    let policy = HistoricalWorkBudget {}; return policy.reserve_edit(state, call);
}
public flow bump_edit_mode(state: Ledger, call: bool, high_input: bool) -> Result<Ledger, string> {
    if high_input { let policy = HighInputWorkBudget {}; return policy.reserve_edit(state, call); }
    return bump_edit(state, call);
}

flow selected_error(value: Evidence, complete: bool) -> string {
    if !bounded(value.request, 512) || !bounded(value.task, 512) || !bounded(value.result, child_answer_bytes()) ||
        !bounded(value.outcome, outcome_bytes()) || !starts_with(value.outcome, "complete: ") { return "invalid read evidence text"; }
    let allowed = allowed_error(value.allowed); if allowed != "" { return allowed; }
    let files = allowed_error(value.files); if files != "" { return files; }
    var fields: Array<string> = [];
    if value.operation == "read" && count(value.files) == 1 && value.literal == "" { fields = ["read", value.files[0]]; }
    else if value.operation == "search" {
        fields = ["search", value.literal, value.files[0]];
        if count(value.files) >= 2 { fields = fields.push(value.files[1]); }
        if count(value.files) >= 3 { fields = fields.push(value.files[2]); }
        if count(value.files) >= 4 { fields = fields.push(value.files[3]); }
    } else { return "read evidence requires a read or search"; }
    let raw = match json(fields) { Ok(item) => item, Err(error) => { return error; } };
    match decode_reply(raw, value.allowed, false) { Ok(_) => {} Err(error) => { return error; } }
    let invalid = read_error(value.ledger); if invalid != "" { return invalid; }
    if complete {
        if !read_complete(value.ledger) || !bounded(value.summary, 512) { return "read evidence is not settled"; }
    } else if value.summary != "" || value.ledger.steps != 5 || value.ledger.calls != 3 || (value.ledger.tokens != 6144 && value.ledger.tokens != 10240 && value.ledger.tokens != 12288 && value.ledger.tokens != 16384 && value.ledger.tokens != 139264) ||
        value.ledger.tools != 1 || (value.ledger.scan != 4096 && value.ledger.scan != 16384 && value.ledger.scan != 65540 && value.ledger.scan != scan_i32()) { return "invalid pending read evidence"; }
    return "";
}

public flow evidence_error(value: Evidence) -> string { return selected_error(value, true); }

// Admit only the ordinary, source-constructed successful tool-child shape.
// A direct final answer cannot substitute for an actual complete tool outcome.
public flow collect(child: Session, status: i32, request: string, task: string, allowed: Array<string>, wide: bool) -> Result<Evidence, string> {
    let observed = match inspect(child, status, request, task, allowed) { Ok(value) => value, Err(error) => { return Err(error); } };
    if status != 0 || (observed.tool != "read" && observed.tool != "search") { return Err("work requires a successful read or search child"); }
    let selected = match decode_reply(child.history.events[3].text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
    let reserved = ReadLedger { steps = 2, calls = 1, tokens = if wide { 4096 } else { 2048 }, tools = 0, scan = 0 };
    let ledger = match settle(reserved, child) { Ok(value) => value, Err(error) => { return Err(error); } };
    let evidence = Evidence { request = request, task = task, operation = selected.operation, files = selected.files,
        literal = selected.literal, outcome = observed.outcome, result = observed.result, summary = "", allowed = allowed, ledger = ledger };
    let invalid = selected_error(evidence, false); if invalid != "" { return Err(invalid); }
    return Ok(evidence);
}

// The controller separately precharges these two stages before its summary
// Model call, then compares the returned ledger with its invocation ledger.
public flow finish_evidence(value: Evidence, summary: string) -> Result<Evidence, string> {
    let invalid = selected_error(value, false); if invalid != "" { return Err(invalid); }
    let wide = value.ledger.tokens == 12288 || value.ledger.tokens == 16384 || value.ledger.tokens == 139264;
    let consumed = match if wide { wide_bump(value.ledger, false) } else { read_bump(value.ledger, false) } { Ok(item) => item, Err(error) => { return Err(error); } };
    let ledger = match if wide { wide_bump(consumed, true) } else { read_bump(consumed, true) } { Ok(item) => item, Err(error) => { return Err(error); } };
    let result = Evidence { request = value.request, task = value.task, operation = value.operation, files = value.files,
        literal = value.literal, outcome = value.outcome, result = value.result, summary = summary, allowed = value.allowed, ledger = ledger };
    let error = evidence_error(result); if error != "" { return Err(error); }
    return Ok(result);
}

public flow context_error(value: Context) -> string {
    let evidence = evidence_error(value.evidence); if evidence != "" { return evidence; }
    let edit = edit_context_error(value.edit); if edit != "" { return edit; }
    if value.edit.request != value.evidence.request { return "read and edit original request changed"; }
    let encoded = match encode_json(value, "work context conversion refused", "work context JSON refused") { Ok(value) => value, Err(error) => { return error; } };
    if byte_count(utf8_encode(encoded)) > 8388608 { return "work context exceeds 8388608 serialized UTF-8 bytes"; }
    return "";
}
