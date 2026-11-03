module nomo.harness.harness_work_contract;

import std.text.starts_with;
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.model.model_tool_contract.{Session, allowed_error};
import nomo.model.read_protocol.decode_child as decode_reply;
import nomo.core.read_text.bounded;
import nomo.harness.read_tool_contract.inspect_work as inspect;
import nomo.harness.harness_tool_contract.settle;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_tool_contract.fresh as read_fresh;
import nomo.harness.harness_tool_contract.bump as read_bump;
import nomo.harness.harness_tool_contract.ledger_error as read_error;
import nomo.harness.harness_edit_contract.Context as EditContext;
import nomo.harness.harness_edit_contract.Ledger as EditLedger;
import nomo.harness.harness_edit_contract.fresh as edit_fresh;
import nomo.harness.harness_edit_contract.bump as edit_bump;
import nomo.harness.harness_edit_contract.ledger_error as edit_error;
import nomo.harness.harness_edit_contract.context_error as edit_context_error;
import nomo.tools.edit_encoding.json;

public type Evidence = { request: string, task: string, operation: string, files: Array<string>, literal: string,
    outcome: string, result: string, summary: string, allowed: Array<string>, ledger: ReadLedger };
public type Context = { edit: EditContext, evidence: Evidence };
public type Ledger = { read: ReadLedger, edit: EditLedger };

public flow fresh() -> Ledger { return Ledger { read = read_fresh(), edit = edit_fresh() }; }

flow read_complete(value: ReadLedger) -> bool {
    return value.steps == 7 && value.calls == 4 && value.tokens == 8192 && value.tools == 1 && value.scan == 4096;
}

// This is a configured cumulative ceiling, never measured provider usage.
public flow native_tokens(state: Ledger) -> i32 {
    if read_error(state.read) != "" || edit_error(state.edit) != "" { return 0; }
    return state.read.calls * 8192 + state.edit.native_tokens;
}

public flow ledger_error(state: Ledger) -> string {
    let read = read_error(state.read); if read != "" { return read; }
    let edit = edit_error(state.edit); if edit != "" { return edit; }
    if state.edit.steps != 0 && !read_complete(state.read) { return "edit tail requires settled read work"; }
    if state.read.steps + state.edit.steps > 13 || state.read.calls + state.edit.calls > 7 ||
        state.read.tokens + state.edit.tokens > 47104 || native_tokens(state) > 196608 {
        return "shared work reservation exhausted";
    }
    return "";
}

// Both reservations are created once, before any Model/File work. The read
// ledger remains in this value while the existing edit ledger advances.
public flow bump_edit(state: Ledger, call: bool) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if !read_complete(state.read) { return Err("edit tail requires settled read work"); }
    let edit = match edit_bump(state.edit, call) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Ledger { read = state.read, edit = edit });
}

flow selected_error(value: Evidence, complete: bool) -> string {
    if !bounded(value.request, 128) || !bounded(value.task, 512) || !bounded(value.result, 256) ||
        !bounded(value.outcome, 266) || !starts_with(value.outcome, "complete: ") { return "invalid read evidence text"; }
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
    } else if value.summary != "" || value.ledger.steps != 5 || value.ledger.calls != 3 || value.ledger.tokens != 6144 ||
        value.ledger.tools != 1 || value.ledger.scan != 4096 { return "invalid pending read evidence"; }
    return "";
}

public flow evidence_error(value: Evidence) -> string { return selected_error(value, true); }

// Admit only the ordinary, source-constructed successful tool-child shape.
// A direct final answer cannot substitute for an actual complete tool outcome.
public flow collect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Evidence, string> {
    let observed = match inspect(child, status, request, task, allowed) { Ok(value) => value, Err(error) => { return Err(error); } };
    if status != 0 || (observed.tool != "read" && observed.tool != "search") { return Err("work requires a successful read or search child"); }
    let selected = match decode_reply(child.history.events[3].text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
    let reserved = ReadLedger { steps = 2, calls = 1, tokens = 2048, tools = 0, scan = 0 };
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
    let consumed = match read_bump(value.ledger, false) { Ok(item) => item, Err(error) => { return Err(error); } };
    let ledger = match read_bump(consumed, true) { Ok(item) => item, Err(error) => { return Err(error); } };
    let result = Evidence { request = value.request, task = value.task, operation = value.operation, files = value.files,
        literal = value.literal, outcome = value.outcome, result = value.result, summary = summary, allowed = value.allowed, ledger = ledger };
    let error = evidence_error(result); if error != "" { return Err(error); }
    return Ok(result);
}

public flow context_error(value: Context) -> string {
    let evidence = evidence_error(value.evidence); if evidence != "" { return evidence; }
    let edit = edit_context_error(value.edit); if edit != "" { return edit; }
    if value.edit.request != value.evidence.request { return "read and edit original request changed"; }
    let message = Message.new(value);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match conversion { Some(item) => item.body, None() => { return "work context conversion refused"; } };
    let encoded = match stringify(data) { Ok(item) => item, Err(_) => { return "work context JSON refused"; } };
    if byte_count(utf8_encode(encoded)) > 65536 { return "work context exceeds 65536 serialized UTF-8 bytes"; }
    return "";
}
