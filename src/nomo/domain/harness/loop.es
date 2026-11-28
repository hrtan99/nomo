module nomo.domain.harness.loop;

import nomo.core.conversation.{Event, State};
import nomo.domain.conversation.{charge, fresh};
import nomo.domain.limits.{context_bytes, edit_response_bytes, message_bytes, message_frame_bytes, outcome_bytes};
import nomo.domain.text.{context_json_error, search_literal, text_printable};
import nomo.domain.wire.{FieldError, decode_fields, json};
import nomo.domain.workspace.valid_path;
import std.agent.message.Message;
import std.collections.unique;
import std.json.JsonValue;
import std.text.{char_count, contains, from_char, from_usize, len, lowercase, trim};

public type Shape = { calls: usize, tools: usize, context_bytes: usize, input_characters: usize, result_characters: usize, slots: usize, characters: usize, tool_characters: usize, whole_scope: bool, partial_search: bool, named_final: bool, legacy_text: bool };

flow phase_name(value: string) -> string {
    return if ["read-plan", "read-child-action", "read-child-final", "read-aggregate", "edit-plan", "edit-child", "edit-aggregate"].iter().any(known => value == known) { value } else { "unknown" };
}

flow category_name(value: string) -> string {
    return if ["limit", "control", "frame", "json", "shape", "arity", "verb", "task", "target", "replacement", "summary", "proposal", "field", "files", "literal", "result", "answer", "fence", "object", "prose"].iter().any(known => value == known) { value } else { "unknown" };
}

flow limit(maximum: usize) -> usize { return if maximum > 0 && maximum <= edit_response_bytes() { maximum } else { 384 }; }

// Preserve the historical scalar-count diagnostic while measuring UTF-8 bytes
// only after the response is within the configured scalar bound.
public flow response_error(raw: string, phase: string, category: string, maximum: usize) -> string {
    var bytes = "unmeasured";
    if char_count(raw) <= limit(maximum) { bytes = from_usize(len(raw)); }
    return "phase=" + phase_name(phase) + " category=" + category_name(category) + " chars=" + from_usize(char_count(raw)) + " utf8=" + bytes;
}

public flow read_plan_error(raw: string, category: string) -> string { return response_error(raw, "read-plan", category, 384); }

flow header(phase: string, clipped: bool, redacted: bool) -> string {
    return "phase=" + phase_name(phase) + " returned-text clipped=" + if clipped { "true" } else { "false" } +
        " redacted=" + if redacted { "true" } else { "false" } + " text=";
}

flow shown(phase: string, text: string, clipped: bool, redacted: bool) -> string {
    let encoded = match json([text]) { Ok(value) => value, Err(_) => { return header(phase, true, true) + "[\"<unavailable>\"]"; } };
    return header(phase, clipped, redacted) + encoded;
}

// Fixture caller supplies a known nonsecret credential prefix. Empty exclusion
// fails closed. Check the entire raw value before any clipping or formatting.
public flow response_text(raw: string, phase: string, excluded: string, maximum: usize) -> string {
    if excluded == "" || contains(raw, excluded) || contains(raw, "Bearer") || contains(raw, "bearer") || contains(raw, "BEARER") ||
        contains(raw, "Authorization") || contains(raw, "authorization") || contains(raw, "AUTHORIZATION") ||
        contains(raw, "api-key") || contains(raw, "API-Key") || contains(raw, "API-KEY") || contains(raw, "api_key") || contains(raw, "API_KEY") {
        return shown(phase, "<redacted>", false, true);
    }
    if char_count(raw) > limit(maximum) { return shown(phase, "<omitted:raw-limit>", true, false); }
    let folded = lowercase(raw);
    if contains(folded, "authorization") || contains(folded, "bearer") || contains(folded, "api-key") || contains(folded, "api_key") { return shown(phase, "<redacted>", false, true); }
    var prefix = ""; var size: usize = 4; var clipped = false;
    let maximum_encoded = 384 - char_count(header(phase, false, false));
    @limits([Iterations(32770)]) for codepoint in std.text.chars(raw) { let character = std.text.from_char(codepoint);
        if character != "" {
            let encoded = match json([character]) { Ok(value) => value, Err(_) => { return shown(phase, "<unavailable>", true, true); } };
            let width = char_count(encoded) - 4;
            if size + width > maximum_encoded { clipped = true; break; }
            prefix = prefix + character; size = size + width;
        }
    }
    return shown(phase, prefix, clipped, false);
}

public flow returned_text(raw: string, excluded: string) -> string { return response_text(raw, "read-plan", excluded, 384); }

public type Action = { operation: string, files: Array<string>, literal: string, text: string };

public type Session = { history: State, calls: usize, tokens: usize, tools: usize, scan: usize };

public type LoopTurn = { state: Session, status: i32 };

public type Limits = { steps: i32, calls: usize, tokens: usize, scan: usize };

public flow fresh_loop() -> Session {
    return Session { history = fresh(), calls = 0, tokens = 0, tools = 0, scan = 0 };
}

public flow default_limits() -> Limits { return Limits { steps = 3, calls = 2, tokens = 4096, scan = 16384 }; }

public flow question_error(raw: string) -> string {
    if char_count(raw) == 0 || char_count(raw) > message_bytes() || !text_printable(raw) || trim(raw) == "" {
        return "question requires 1..1048576 printable ASCII chars, not only spaces";
    }
    return "";
}

flow selected_error(names: Array<string>, allowed: Array<string>) -> string {
    if names.len() > 4 { return "at most four selected files"; }
    let invalid = allowed_error(names);
    if invalid != "" { return invalid; }
    if names.iter().any(name => !allowed.iter().any(admitted => name == admitted)) { return "selected file is not allowed"; }
    return "";
}

// Shared semantic selection guard for legacy wire decoding and native records.
public flow read_selection_error(operation: string, files: Array<string>, literal: string, allowed: Array<string>) -> string {
    let invalid = candidate_error(allowed); if invalid != "" { return invalid; }
    if operation == "read" {
        if files.len() != 1 { return "unsupported action or arity"; }
        if literal != "" { return "read action requires an empty literal"; }
    } else if operation == "search" {
        if !search_literal(literal) { return "invalid search literal"; }
    } else { return "unsupported action or arity"; }
    return selected_error(files, allowed);
}

// Bound the raw allocation and reject nested/object/scalar JSON before parsing.
// JSON parsing below still validates commas, escapes and complete consumption.
flow frame_error(raw: string) -> string {
    if char_count(raw) == 0 || char_count(raw) > message_frame_bytes() { return "limit"; }
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    let slash = from_char('\\');
    @limits([Iterations(8388610)]) for codepoint in std.text.chars(raw) { let character = std.text.from_char(codepoint);
        if character != "" && !text_printable(character) { return "control"; }
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " {
        } else if character == "[" {
            if opened || closed { return "shape"; }
            opened = true;
        } else if character == "]" {
            if !opened || closed { return "frame"; }
            closed = true;
        } else if character == "\"" {
            if !opened || closed { return "frame"; }
            leaves = leaves + 1;
            if leaves > 4 { return "arity"; }
            quoted = true;
        } else if character != "," || !opened || closed { return "frame"; }
    }
    return if opened && closed && !quoted { "" } else { "frame" };
}

flow framed(raw: string) -> bool { return frame_error(raw) == ""; }

public flow decode_reply(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let invalid = allowed_error(allowed);
    if invalid != "" { return Err(invalid); }
    if !framed(raw) { return Err("expected bounded flat single-line JSON string array"); }
    let fields = match decode_fields(raw) {
        Ok(value) => value,
        Err(FieldError.Json) => { return Err("invalid action JSON"); }
        Err(FieldError.Shape) => { return Err("action fields must be strings"); }
    };
    if fields.len() < 2 || fields.len() > 4 { return Err("invalid action field count"); }
    if fields[0] == "final" {
        if fields.len() != 2 || char_count(fields[1]) == 0 || char_count(fields[1]) > message_bytes() ||
            !text_printable(fields[1]) || trim(fields[1]) == "" { return Err("invalid bounded final answer"); }
        let action = Action { operation = "final", files = [], literal = "", text = fields[1] };
        return Ok(action);
    }
    if final_only { return Err("second response must be final"); }
    if char_count(raw) > message_frame_bytes() { return Err("tool action exceeds 8388608 raw characters"); }
    var files: Array<string> = [];
    var literal = "";
    if fields[0] == "read" && fields.len() == 2 { files = [fields[1]]; }
    else if fields[0] == "search" && (fields.len() == 3 || fields.len() == 4) {
        literal = fields[1];
        files = [fields[2]];
        if fields.len() == 4 { files = files.push(fields[3]); }
    } else { return Err("unsupported action or arity"); }
    let selected = read_selection_error(fields[0], files, literal, allowed);
    if selected != "" { return Err(selected); }
    let action = Action { operation = fields[0], files, literal, text = "" };
    return Ok(action);
}

flow work_category(raw: string, error: string) -> string {
    if error == "invalid action JSON" { return "json"; }
    if error == "action fields must be strings" { return "shape"; }
    if error == "invalid action field count" { return "arity"; }
    if error == "invalid bounded final answer" { return "answer"; }
    if error == "second response must be final" { return "verb"; }
    if error == "tool action exceeds 8388608 raw characters" { return "limit"; }
    if error == "invalid search literal" { return "literal"; }
    if error == "unsupported action or arity" {
        let fields = match decode_fields(raw) { Ok(value) => value, Err(FieldError.Json) => { return "json"; } Err(FieldError.Shape) => { return "shape"; } };
        return if fields[0] == "read" || fields[0] == "search" { "arity" } else { "verb" };
    }
    return "files";
}

// The v2 work intersection requires a tool first and a <=256-character result.
// Legacy decode_reply and its history/evidence revalidation remain strict.
public flow decode_work_reply(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let phase = if final_only { "read-child-final" } else { "read-child-action" };
    let maximum: usize = message_frame_bytes();
    if char_count(raw) == 0 || char_count(raw) > maximum { return Err(response_error(raw, phase, "limit", maximum)); }
    let frame = frame_error(raw); if frame != "" { return Err(response_error(raw, phase, frame, maximum)); }
    let action = match decode_reply(raw, allowed, final_only) {
        Ok(value) => value, Err(error) => { return Err(response_error(raw, phase, work_category(raw, error), maximum)); }
    };
    if !final_only && action.operation == "final" { return Err(response_error(raw, phase, "verb", maximum)); }
    if final_only && char_count(action.text) > message_bytes() { return Err(response_error(raw, phase, "answer", maximum)); }
    return Ok(action);
}

// Prompt.data uses the same checked HostValue -> JSON conversion. Inspect the
// whole serialized record, including escaped strings, metadata and both paths.
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(message.cast<JsonValue>(), context_bytes(), false, "model context exceeds 33554432 serialized characters");
}

// Admission and charging are separate pure operations. The caller must perform
// admission before the charge and adapter action; failures never refund it.
public flow budget_error(state: Session, limits: Limits, tool: bool) -> string {
    if state.history.stopped { return "invocation already stopped"; }
    if state.history.spent < 0 || state.history.spent >= 3 || state.history.spent >= limits.steps {
        return "total step reservation exhausted";
    }
    if state.calls > 2 || state.tokens > 4096 || state.tools > 1 || state.scan > 16384 {
        return "invalid action ledgers";
    }
    if tool {
        if state.tools >= 1 || state.scan > 0 || limits.scan < 4096 { return "tool scan reservation exhausted"; }
    } else {
        if state.calls >= 2 || state.calls >= limits.calls { return "model call reservation exhausted"; }
        if state.tokens > 2048 || limits.tokens < 2048 { return "model token reservation exhausted"; }
        if state.tokens > limits.tokens - 2048 { return "model token reservation exhausted"; }
    }
    return "";
}

public flow charge_action(state: Session, tool: bool, limits: Limits) -> Session {
    return Session { history = charge(state.history), calls = state.calls + if tool { 0 } else { 1 },
        tokens = state.tokens + if tool { 0 } else { 2048 }, tools = state.tools + if tool { 1 } else { 0 },
        scan = state.scan + if tool { if limits.scan >= 16384 { 16384 } else { 4096 } } else { 0 } };
}

public type ToolSelection = { operation: string, files: Array<string>, literal: string, text: string };

public enum LoopMode {
    Public(limits: Limits, work: bool, inspect: bool),
    Private(limits: Limits, work: bool),
    Chat(limits: Limits, redacted: bool),
    Expanded(wide: bool, high_input: bool),
    Multi(redacted: bool, resilient: bool, reasoning: bool),
}

public type Context = { history: Array<Event>, allowed: Array<string>, final_only: bool };

flow paths_error(names: Array<string>, maximum: usize, path_limit: usize) -> string {
    if names.len() < 1 || names.len() > maximum { return if maximum == 4 { "expected one to four allowed files" } else { "expected 1..256 discovered files" }; }
    if names.iter().any(name => char_count(name) > path_limit || !valid_path(name)) { return "invalid allowed file"; }
    if unique(names).len() != names.len() { return "duplicate allowed file"; }
    return "";
}

public flow allowed_error(names: Array<string>) -> string { return paths_error(names, 4, 128); }

public flow candidate_error(names: Array<string>) -> string { return paths_error(names, 256, 128); }

// Bound the closed String/Bool payload before encoding. This is an input
// allocation bound, not a token estimate or a generic typed-value serializer.
public flow bounded_context_error(value: Context) -> string {
    let invalid = candidate_error(value.allowed); if invalid != "" { return invalid; }
    if value.history.len() > 32 { return "context history exceeds 32 events"; }
    if value.history.iter().any(event => char_count(event.role) > 128 || char_count(event.kind) > 128 || char_count(event.name) > 128 || char_count(event.text) > outcome_bytes()) {
        return "context event exceeds bounded input";
    }
    return "";
}
