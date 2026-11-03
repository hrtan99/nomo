module nomo.model.model_tool_contract;

import std.text.{len, trim, split};
import std.collections.len as count;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.core.text.printable;
import nomo.core.read_text.search_literal;
import nomo.harness.model_plan_diagnostic.response_error;
public import nomo.model.tool_context.{Context, allowed_error, candidate_error};
import nomo.core.conversation.{State, fresh, charge};

public type Action = { operation: string, files: Array<string>, literal: string, text: string };
public type Session = { history: State, calls: usize, tokens: usize, tools: usize, scan: usize };
public type LoopTurn = { state: Session, status: i32 };
public type Limits = { steps: i32, calls: usize, tokens: usize, scan: usize };

public flow fresh_loop() -> Session {
    return Session { history = fresh(), calls = 0, tokens = 0, tools = 0, scan = 0 };
}

public flow default_limits() -> Limits { return Limits { steps = 3, calls = 2, tokens = 4096, scan = 16384 }; }

public flow question_error(raw: string) -> string {
    if len(raw) == 0 || len(raw) > 128 || !printable(raw) || trim(raw) == "" {
        return "question requires 1..128 printable ASCII chars, not only spaces";
    }
    return "";
}

flow selected_error(names: Array<string>, allowed: Array<string>) -> string {
    if count(names) > 4 { return "at most four selected files"; }
    let invalid = allowed_error(names);
    if invalid != "" { return invalid; }
    for name in names limit Iterations(4) {
        var permitted = false;
        for admitted in allowed limit Iterations(256) {
            if name == admitted { permitted = true; }
        }
        if !permitted { return "selected file is not allowed"; }
    }
    return "";
}

// Shared semantic selection guard for legacy wire decoding and native records.
public flow read_selection_error(operation: string, files: Array<string>, literal: string, allowed: Array<string>) -> string {
    let invalid = candidate_error(allowed); if invalid != "" { return invalid; }
    if operation == "read" {
        if count(files) != 1 { return "unsupported action or arity"; }
        if literal != "" { return "read action requires an empty literal"; }
    } else if operation == "search" {
        if !search_literal(literal) { return "invalid search literal"; }
    } else { return "unsupported action or arity"; }
    return selected_error(files, allowed);
}

// Bound the raw allocation and reject nested/object/scalar JSON before parsing.
// JSON parsing below still validates commas, escapes and complete consumption.
flow frame_error(raw: string) -> string {
    if len(raw) == 0 || len(raw) > 1152 { return "limit"; }
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(1154) {
        if character != "" && !printable(character) { return "control"; }
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
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { return Err("invalid action JSON"); } };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match conversion { Some(value) => value.body, None() => { return Err("action fields must be strings"); } };
    if count(fields) < 2 || count(fields) > 4 { return Err("invalid action field count"); }
    if fields[0] == "final" {
        if count(fields) != 2 || len(fields[1]) == 0 || len(fields[1]) > 512 ||
            !printable(fields[1]) || trim(fields[1]) == "" { return Err("invalid bounded final answer"); }
        let action = Action { operation = "final", files = [], literal = "", text = fields[1] };
        return Ok(action);
    }
    if final_only { return Err("second response must be final"); }
    if len(raw) > 384 { return Err("tool action exceeds 384 raw characters"); }
    var files: Array<string> = [];
    var literal = "";
    if fields[0] == "read" && count(fields) == 2 { files = [fields[1]]; }
    else if fields[0] == "search" && (count(fields) == 3 || count(fields) == 4) {
        literal = fields[1];
        files = [fields[2]];
        if count(fields) == 4 { files = files.push(fields[3]); }
    } else { return Err("unsupported action or arity"); }
    let selected = read_selection_error(fields[0], files, literal, allowed);
    if selected != "" { return Err(selected); }
    let action = Action { operation = fields[0], files = files, literal = literal, text = "" };
    return Ok(action);
}

flow work_category(raw: string, error: string) -> string {
    if error == "invalid action JSON" { return "json"; }
    if error == "action fields must be strings" { return "shape"; }
    if error == "invalid action field count" { return "arity"; }
    if error == "invalid bounded final answer" { return "answer"; }
    if error == "second response must be final" { return "verb"; }
    if error == "tool action exceeds 384 raw characters" { return "limit"; }
    if error == "invalid search literal" { return "literal"; }
    if error == "unsupported action or arity" {
        let parsed = match parse(raw) { Ok(value) => value, Err(_) => { return "json"; } };
        let message = Message.new(parsed); let converted: Option<Message<Array<string>>> = message.cast<Array<string>>();
        let fields = match converted { Some(value) => value.body, None() => { return "shape"; } };
        return if fields[0] == "read" || fields[0] == "search" { "arity" } else { "verb" };
    }
    return "files";
}
// The v2 work intersection requires a tool first and a <=256-character result.
// Legacy decode_reply and its history/evidence revalidation remain strict.
public flow decode_work_reply(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let phase = if final_only { "read-child-final" } else { "read-child-action" };
    let maximum: usize = if final_only { 1152 } else { 384 };
    if len(raw) == 0 || len(raw) > maximum { return Err(response_error(raw, phase, "limit", maximum)); }
    let frame = frame_error(raw); if frame != "" { return Err(response_error(raw, phase, frame, maximum)); }
    let action = match decode_reply(raw, allowed, final_only) {
        Ok(value) => value, Err(error) => { return Err(response_error(raw, phase, work_category(raw, error), maximum)); }
    };
    if !final_only && action.operation == "final" { return Err(response_error(raw, phase, "verb", maximum)); }
    if final_only && len(action.text) > 256 { return Err(response_error(raw, phase, "answer", maximum)); }
    return Ok(action);
}

// Prompt.data uses the same checked HostValue -> JSON conversion. Inspect the
// whole serialized record, including escaped strings, metadata and both paths.
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if len(encoded) > 262144 { return "model context exceeds 262144 serialized characters"; }
    return "";
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
