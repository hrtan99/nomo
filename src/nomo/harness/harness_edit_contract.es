module nomo.harness.harness_edit_contract;

import std.text.{len, split, trim, contains};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.tools.edit_proposal.text_bytes;
import nomo.tools.edit_encoding.digest;
import nomo.harness.model_plan_diagnostic.response_error;
import nomo.session.edit_operation.{Binding, selector_error, binding_error};

// Shared serialization bound for historical model inputs.
public flow history_bound(converted: Option<Message<JsonValue>>, maximum: usize, kind: string) -> unit {
    let data = match converted { Some(item) => item.body, None() => { abort("history " + kind + " context conversion refused"); } };
    let raw = match stringify(data) { Ok(item) => item, Err(_) => { abort("history " + kind + " context encoding refused"); } };
    if byte_count(utf8_encode(raw)) > maximum { abort(if kind == "read" { "history read context exceeds 1048576 bytes" } else { "history edit context exceeds 1048576 bytes" }); }
}

public type Child = { target: string, replacement: string };
public type Context = { phase: string, request: string, task: string, id: string, workspace: string, path: string,
    before: string, after: string, request_digest: string, before_digest: string, after_digest: string,
    before_bytes: usize, after_bytes: usize, completed: bool };
public type Ledger = { steps: i32, calls: i32, tokens: i32, native_tokens: i32, boundaries: i32 };

public flow fresh() -> Ledger { return Ledger { steps = 0, calls = 0, tokens = 0, native_tokens = 0, boundaries = 0 }; }

// Conservative allowances are charged before attempts, independently of usage.
// The fixed three-call reservation includes final aggregation from the start.
flow error_mode(state: Ledger, wide: bool) -> string {
    if state.steps < 0 || state.steps > 6 || state.calls < 0 || state.calls > 3 ||
        state.tokens < 0 || state.tokens > if wide { 45056 } else { 38912 } || state.native_tokens < 0 || state.native_tokens > 163840 ||
        state.boundaries < 0 || state.boundaries > 3 {
        return "invalid shared edit ledger";
    }
    let allowance: i32 = if wide { match state.calls { 0 => 0, 1 => 8192, 2 => 40960, _ => 45056 } } else { match state.calls { 0 => 0, 1 => 4096, 2 => 36864, _ => 38912 } };
    let native_allowance: i32 = match state.calls { 0 => 0, 1 => 32768, 2 => 98304, _ => 163840 };
    let stage = (state.calls == 0 && state.boundaries == 0) || (state.calls == 1 && state.boundaries <= 1) ||
        (state.calls == 2 && state.boundaries >= 1 && state.boundaries <= 3) || (state.calls == 3 && state.boundaries == 3);
    if !stage || state.steps != state.calls + state.boundaries || state.tokens != allowance || state.native_tokens != native_allowance {
        return "invalid shared edit ledger";
    }
    return "";
}

public flow ledger_error(state: Ledger) -> string { return error_mode(state, false); }
public flow wide_error(state: Ledger) -> string { return error_mode(state, true); }
public flow bump_mode(state: Ledger, call: bool, wide: bool) -> Result<Ledger, string> {
    let invalid = error_mode(state, wide); if invalid != "" { return Err(invalid); }
    let call_stage = (state.calls == 0 && state.boundaries == 0) ||
        (state.calls == 1 && state.boundaries == 1) || (state.calls == 2 && state.boundaries == 3);
    let boundary_stage = (state.calls == 1 && state.boundaries == 0) ||
        (state.calls == 2 && state.boundaries >= 1 && state.boundaries <= 2);
    if state.steps >= 6 || (call && !call_stage) || (!call && !boundary_stage) {
        return Err("shared edit reservation exhausted");
    }
    let allowance: i32 = match state.calls { 0 => if wide { 8192 } else { 4096 }, 1 => 32768, _ => if wide { 4096 } else { 2048 } };
    let native_allowance: i32 = match state.calls { 0 => 32768, _ => 65536 };
    return Ok(Ledger { steps = state.steps + 1, calls = state.calls + if call { 1 } else { 0 },
        tokens = state.tokens + if call { allowance } else { 0 }, native_tokens = state.native_tokens + if call { native_allowance } else { 0 },
        boundaries = state.boundaries + if call { 0 } else { 1 } });
}

public flow bump(state: Ledger, call: bool) -> Result<Ledger, string> { return bump_mode(state, call, false); }

public flow text_error(text: string, field: string) -> string {
    if len(text) == 0 || len(text) > 512 || trim(text) == "" { return field + " requires 1..512 nonblank UTF-8 bytes"; }
    let size = match text_bytes(text, field) { Ok(value) => value, Err(error) => { return error; } };
    if size > 512 { return field + " requires 1..512 nonblank UTF-8 bytes"; }
    return "";
}

// History-work summaries are complete facts, not abbreviated context.
public flow history_fallback_summary() -> string { return "Edit applied; model summary unavailable (blank or over limit)."; }
public flow history_summary_error(text: string, field: string) -> string {
    if len(text) == 0 || len(text) > 1024 || trim(text) == "" { return field + " requires 1..1024 nonblank UTF-8 bytes"; }
    let size = match text_bytes(text, field) { Ok(value) => value, Err(error) => { return error; } };
    if size > 1024 { return field + " requires 1..1024 nonblank UTF-8 bytes"; }
    return "";
}

// The same bounded scanner serves legacy and current-v2 decoding. Diagnostic
// classification changes no accepted wire: outside-string JSON whitespace was
// already supported, while quoted data is left for the complete JSON parser.
flow frame_error(raw: string, maximum: usize, fields: usize, diagnostic: bool) -> string {
    if len(raw) == 0 || len(raw) > maximum || byte_count(utf8_encode(raw)) > maximum { return "limit"; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0; let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(32770) {
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " || character == "\t" || character == "\r" || character == "\n" {
        } else if character == "[" {
            if opened || closed { return if diagnostic && !closed { "shape" } else { "frame" }; } opened = true;
        } else if character == "]" {
            if !opened || closed { return "frame"; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return if diagnostic && !closed { "shape" } else { "frame" }; }
            leaves = leaves + 1; if !diagnostic && leaves > fields { return "frame"; } quoted = true;
        } else if character != "," || !opened || closed {
            if diagnostic && !closed && contains("{0123456789-tnf", character) { return "shape"; }
            return "frame";
        }
    }
    if !opened || !closed || quoted { return "frame"; }
    if !diagnostic && leaves != fields { return "frame"; }
    return "";
}
flow decoded(raw: string, maximum: usize, expected: usize, diagnostic: bool) -> Result<Array<string>, string> {
    let phase = if expected == 2 { "edit-plan" } else { "edit-child" };
    let legacy = if expected == 2 { "delegation" } else { "edit" };
    let framed = frame_error(raw, maximum, expected, diagnostic);
    if framed != "" { return Err(if diagnostic { response_error(raw, phase, framed, maximum) } else { "expected bounded flat " + legacy + " JSON" }); }
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { return Err(if diagnostic { response_error(raw, phase, "json", maximum) } else { "invalid " + legacy + " JSON" }); } };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match conversion { Some(value) => value.body, None() => { return Err(if diagnostic { response_error(raw, phase, "shape", maximum) } else { legacy + " fields must be strings" }); } };
    let verb = if expected == 2 { "delegate" } else { "edit" };
    if count(fields) != expected { return Err(if diagnostic { response_error(raw, phase, "arity", maximum) } else { "unsupported " + legacy + " verb or arity" }); }
    if fields[0] != verb { return Err(if diagnostic { response_error(raw, phase, "verb", maximum) } else { "unsupported " + legacy + " verb or arity" }); }
    return Ok(fields);
}
flow plan(raw: string, diagnostic: bool) -> Result<string, string> {
    let fields = match decoded(raw, 4096, 2, diagnostic) { Ok(value) => value, Err(error) => { return Err(error); } };
    let invalid = text_error(fields[1], "delegated task");
    if invalid != "" { return Err(if diagnostic { response_error(raw, "edit-plan", "task", 4096) } else { invalid }); }
    return Ok(fields[1]);
}
flow edit(raw: string, diagnostic: bool) -> Result<Child, string> {
    let fields = match decoded(raw, 32768, 3, diagnostic) { Ok(value) => value, Err(error) => { return Err(error); } };
    let size = match text_bytes(fields[1], "target") { Ok(value) => value, Err(error) => { return Err(if diagnostic { response_error(raw, "edit-child", "target", 32768) } else { error }); } };
    match text_bytes(fields[2], "replacement") { Ok(_) => {} Err(error) => { return Err(if diagnostic { response_error(raw, "edit-child", "replacement", 32768) } else { error }); } }
    if size == 0 { return Err(if diagnostic { response_error(raw, "edit-child", "target", 32768) } else { "target must not be empty" }); }
    return Ok(Child { target = fields[1], replacement = fields[2] });
}
public flow decode_plan(raw: string) -> Result<string, string> { return plan(raw, false); }
public flow decode_edit(raw: string) -> Result<Child, string> { return edit(raw, false); }
public flow decode_work_plan(raw: string) -> Result<string, string> { return plan(raw, true); }
public flow decode_work_edit(raw: string) -> Result<Child, string> { return edit(raw, true); }
public flow work_summary_error(raw: string) -> string {
    if len(raw) == 0 || len(raw) > 512 || byte_count(utf8_encode(raw)) > 512 { return response_error(raw, "edit-aggregate", "limit", 512); }
    let invalid = text_error(raw, "final answer");
    return if invalid == "" { "" } else { response_error(raw, "edit-aggregate", "summary", 512) };
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
    if before == 0 || before != context.before_bytes { return "edit original byte count mismatch"; }
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
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "edit context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "edit context JSON refused"; } };
    if byte_count(utf8_encode(encoded)) > 1048576 { return "edit context exceeds 1048576 serialized UTF-8 bytes"; }
    return "";
}
