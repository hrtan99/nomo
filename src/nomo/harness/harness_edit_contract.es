module nomo.harness.harness_edit_contract;

import nomo.core.large_context.{message_bytes, message_frame_bytes, edit_response_bytes, context_bytes};

import nomo.core.json.encode as encode_json;

public import nomo.application.decoder_contract.EditText as Child;
import nomo.application.decoder_contract.EditProposalDecoder;
import nomo.core.json.{FieldError, decode_fields as json_fields};

import std.text.{char_count as len, len as byte_len, trim, contains, from_char};
import std.collections.len as count;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.tools.edit_proposal.text_bytes;
import nomo.tools.edit_encoding.digest;
import nomo.harness.model_plan_diagnostic.response_error;
import nomo.session.edit_operation.{Binding, selector_error, binding_error};

// Shared serialization bound for historical model inputs.
public flow history_bound(converted: Option<Message<JsonValue>>, maximum: usize, kind: string) -> unit {
    let data = match converted { Some(item) => item.body, None() => { abort("history " + kind + " context conversion refused"); } };
    let raw = match stringify(data) { Ok(item) => item, Err(_) => { abort("history " + kind + " context encoding refused"); } };
    if byte_len(raw) > maximum { abort(if kind == "read" { "history read context exceeds 33554432 bytes" } else { "history edit context exceeds 33554432 bytes" }); }
}

public type Context = { phase: string, request: string, task: string, id: string, workspace: string, path: string,
    before: string, after: string, request_digest: string, before_digest: string, after_digest: string,
    before_bytes: usize, after_bytes: usize, completed: bool };
public type Ledger = { steps: i32, calls: i32, tokens: i32, native_tokens: i32, boundaries: i32 };

public flow fresh() -> Ledger { return Ledger { steps = 0, calls = 0, tokens = 0, native_tokens = 0, boundaries = 0 }; }

// Conservative allowances are charged before attempts, independently of usage.
// The fixed three-call reservation includes final aggregation from the start.
flow error_mode(state: Ledger, wide: bool, large: bool) -> string {
    if state.steps < 0 || state.steps > 6 || state.calls < 0 || state.calls > 3 ||
        state.tokens < 0 || state.tokens > if large { 143360 } else { if wide { 393216 } else { 38912 } } || state.native_tokens < 0 || state.native_tokens > 163840 ||
        state.boundaries < 0 || state.boundaries > 3 {
        return "invalid shared edit ledger";
    }
    let allowance: i32 = if large { match state.calls { 0 => 0, 1 => 8192, 2 => 139264, _ => 143360 } } else { if wide { state.calls * 131072 } else { match state.calls { 0 => 0, 1 => 4096, 2 => 36864, _ => 38912 } } };
    let legacy_wide: i32 = match state.calls { 0 => 0, 1 => 8192, 2 => 40960, _ => 45056 };
    let transitional_wide: i32 = match state.calls { 0 => 0, 1 => 32768, 2 => 65536, _ => 69632 };
    let native_allowance: i32 = match state.calls { 0 => 0, 1 => 32768, 2 => 98304, _ => 163840 };
    let stage = (state.calls == 0 && state.boundaries == 0) || (state.calls == 1 && state.boundaries <= 1) ||
        (state.calls == 2 && state.boundaries >= 1 && state.boundaries <= 3) || (state.calls == 3 && state.boundaries == 3);
    if !stage || state.steps != state.calls + state.boundaries || (state.tokens != allowance && !(wide && !large && (state.tokens == legacy_wide || state.tokens == transitional_wide))) || state.native_tokens != native_allowance {
        return "invalid shared edit ledger";
    }
    return "";
}

public flow ledger_error(state: Ledger) -> string { return error_mode(state, false, false); }
public flow wide_error(state: Ledger) -> string { return error_mode(state, true, false); }
public flow large_error(state: Ledger) -> string { return error_mode(state, true, true); }
public flow bump_mode(state: Ledger, call: bool, wide: bool, large: bool) -> Result<Ledger, string> {
    let invalid = error_mode(state, wide, large); if invalid != "" { return Err(invalid); }
    let call_stage = (state.calls == 0 && state.boundaries == 0) ||
        (state.calls == 1 && state.boundaries == 1) || (state.calls == 2 && state.boundaries == 3);
    let boundary_stage = (state.calls == 1 && state.boundaries == 0) ||
        (state.calls == 2 && state.boundaries >= 1 && state.boundaries <= 2);
    if state.steps >= 6 || (call && !call_stage) || (!call && !boundary_stage) {
        return Err("shared edit reservation exhausted");
    }
    let allowance: i32 = if wide && !large { 131072 } else { match state.calls { 0 => if wide { 8192 } else { 4096 }, 1 => if large { 131072 } else { 32768 }, _ => if wide { 4096 } else { 2048 } } };
    let native_allowance: i32 = match state.calls { 0 => 32768, _ => 65536 };
    return Ok(Ledger { steps = state.steps + 1, calls = state.calls + if call { 1 } else { 0 },
        tokens = state.tokens + if call { allowance } else { 0 }, native_tokens = state.native_tokens + if call { native_allowance } else { 0 },
        boundaries = state.boundaries + if call { 0 } else { 1 } });
}

public flow bump(state: Ledger, call: bool) -> Result<Ledger, string> { return bump_mode(state, call, false, false); }

public flow text_error(text: string, field: string) -> string {
    if len(text) == 0 || len(text) > message_bytes() || trim(text) == "" { return field + " requires 1..1048576 nonblank UTF-8 bytes"; }
    let size = match text_bytes(text, field) { Ok(value) => value, Err(error) => { return error; } };
    if size > message_bytes() { return field + " requires 1..1048576 nonblank UTF-8 bytes"; }
    return "";
}

// History-work summaries are complete facts, not abbreviated context.
public flow history_fallback_summary() -> string { return "Edit applied; model summary unavailable (blank or over limit)."; }
public flow history_summary_error(text: string, field: string) -> string {
    if len(text) == 0 || len(text) > message_bytes() || trim(text) == "" { return field + " requires 1..1048576 nonblank UTF-8 bytes"; }
    let size = match text_bytes(text, field) { Ok(value) => value, Err(error) => { return error; } };
    if size > message_bytes() { return field + " requires 1..1048576 nonblank UTF-8 bytes"; }
    return "";
}

// Native JSON owns framing and escapes; both routes share the byte envelope.

flow decoded(raw: string, maximum: usize, expected: usize, diagnostic: bool) -> Result<Array<string>, string> {
    let phase = if expected == 2 { "edit-plan" } else { "edit-child" };
    let legacy = if expected == 2 { "delegation" } else { "edit" };
    if raw == "" || byte_len(raw) > maximum { return Err(if diagnostic { response_error(raw, phase, "limit", maximum) } else { "expected bounded flat " + legacy + " JSON" }); }
    let fields = match json_fields(raw) {
        Ok(value) => value,
        Err(FieldError.Json) => { return Err(if diagnostic { response_error(raw, phase, "json", maximum) } else { "invalid " + legacy + " JSON" }); }
        Err(FieldError.Shape) => { return Err(if diagnostic { response_error(raw, phase, "shape", maximum) } else { legacy + " fields must be strings" }); }
    };
    let verb = if expected == 2 { "delegate" } else { "edit" };
    if count(fields) != expected { return Err(if diagnostic { response_error(raw, phase, "arity", maximum) } else { "unsupported " + legacy + " verb or arity" }); }
    if fields[0] != verb { return Err(if diagnostic { response_error(raw, phase, "verb", maximum) } else { "unsupported " + legacy + " verb or arity" }); }
    return Ok(fields);
}
flow plan(raw: string, diagnostic: bool) -> Result<string, string> {
    let fields = match decoded(raw, message_frame_bytes(), 2, diagnostic) { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid = text_error(fields[1], "delegated task");
    if invalid != "" { return Err(if diagnostic { response_error(raw, "edit-plan", "task", message_frame_bytes()) } else { invalid }); }
    return Ok(fields[1]);
}
flow edit(raw: string, diagnostic: bool, empty: bool) -> Result<Child, string> {
    let fields = match decoded(raw, edit_response_bytes(), 3, diagnostic) { Ok(value) => value, Err(error) => { return Err(error); } };
    let size = match text_bytes(fields[1], "target") { Ok(value) => value, Err(error) => { return Err(if diagnostic { response_error(raw, "edit-child", "target", edit_response_bytes()) } else { error }); } };
    match text_bytes(fields[2], "replacement") { Ok(_) => {} Err(error) => { return Err(if diagnostic { response_error(raw, "edit-child", "replacement", edit_response_bytes()) } else { error }); } }
    if size == 0 && !empty { return Err(if diagnostic { response_error(raw, "edit-child", "target", edit_response_bytes()) } else { "target must not be empty" }); }
    return Ok(Child { target = fields[1], replacement = fields[2] });
}
public flow decode_plan(raw: string) -> Result<string, string> { return plan(raw, false); }
public type EditProposal = { diagnostic: bool, empty: bool };
impl EditProposal ~ EditProposalDecoder {
    flow decode(self, raw: string) -> Result<Child, string> { return edit(raw, self.diagnostic, self.empty); }
}
public flow decode_edit(raw: string) -> Result<Child, string> { let decoder = EditProposal { diagnostic = false, empty = false }; return decoder.decode(raw); }
public flow decode_empty_edit(raw: string) -> Result<Child, string> { let decoder = EditProposal { diagnostic = false, empty = true }; return decoder.decode(raw); }
public flow decode_work_plan(raw: string) -> Result<string, string> { return plan(raw, true); }
public flow decode_work_edit(raw: string) -> Result<Child, string> { let decoder = EditProposal { diagnostic = true, empty = false }; return decoder.decode(raw); }
public flow work_summary_error(raw: string) -> string {
    if len(raw) == 0 || len(raw) > message_bytes() || byte_len(raw) > message_bytes() { return response_error(raw, "edit-aggregate", "limit", message_bytes()); }
    let invalid = text_error(raw, "final answer");
    return if invalid == "" { "" } else { response_error(raw, "edit-aggregate", "summary", message_bytes()) };
}

// All fields remain literal complete data. This validates shape and binding;
// only the controller's confirmed Completed value authorizes aggregation.
public flow context_error(context: Context) -> string {
    if context.phase != "plan" && context.phase != "child" && context.phase != "aggregate" {
        return "invalid edit context phase";
    }
    let request = text_error(context.request, "edit request"); if request != "" { return request; }
    if context.task != "" || context.phase != "plan" {
        let task = text_error(context.task, "delegated task"); if task != "" { return task; }
    }
    let selected = selector_error(context.id, context.workspace, context.path); if selected != "" { return selected; }
    let before = match text_bytes(context.before, "original") { Ok(value) => value, Err(error) => { return error; } };
    if before != context.before_bytes { return "edit original byte count mismatch"; }
    if context.phase != "aggregate" {
        if context.completed || context.after != "" || context.after_bytes != 0 || context.request_digest != "" ||
            context.before_digest != "" || context.after_digest != "" { return "uncompleted edit context carries outcome"; }
    } else {
        if !context.completed { return "aggregation requires confirmed edit completion"; }
        let after = match text_bytes(context.after, "result") { Ok(value) => value, Err(error) => { return error; } };
        if after != context.after_bytes { return "edit result byte count mismatch"; }
        let binding = Binding { id = context.id, workspace = context.workspace, region = "nomo.tools.edit_file.EditableRoot",
            path = context.path, request_digest = context.request_digest, before_digest = context.before_digest,
            after_digest = context.after_digest, before_bytes = before, after_bytes = after };
        let invalid = binding_error(binding); if invalid != "" { return invalid; }
        let before_digest = match digest(context.before) { Ok(value) => value, Err(error) => { return error; } };
        let after_digest = match digest(context.after) { Ok(value) => value, Err(error) => { return error; } };
        if before_digest != context.before_digest || after_digest != context.after_digest { return "edit context digest mismatch"; }
    }
    let encoded = match encode_json(context, "edit context conversion refused", "edit context JSON refused") { Ok(value) => value, Err(error) => { return error; } };
    if byte_len(encoded) > context_bytes() { return "edit context exceeds 33554432 serialized UTF-8 bytes"; }
    return "";
}
