module nomo.harness.harness_model_contract;

import std.text.{len, trim, split};
import std.collections.len as count;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.core.text.printable;

public type Context = { phase: string, request: string, task: string, result: string };
public type Ledger = { steps: i32, calls: i32, tokens: i32 };

public flow fresh() -> Ledger { return Ledger { steps = 0, calls = 0, tokens = 0 }; }

public flow bounded(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= 512 && len(text) > 0 && len(text) <= maximum &&
        printable(text) && trim(text) != "";
}

// Bound allocation and flat shape before parsing, including literal controls.
flow framed(raw: string) -> bool {
    if !bounded(raw, 384) { return false; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0;
    let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(386) {
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " {
        } else if character == "[" {
            if opened || closed { return false; } opened = true;
        } else if character == "]" {
            if !opened || closed { return false; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return false; }
            leaves = leaves + 1; if leaves > 2 { return false; } quoted = true;
        } else if character != "," || !opened || closed { return false; }
    }
    return opened && closed && !quoted;
}

public flow decode_plan(raw: string) -> Result<string, string> {
    if !framed(raw) { return Err("expected bounded flat single-line delegation JSON"); }
    let parsed = match parse(raw) { Ok(value) => value, Err(_) => { return Err("invalid delegation JSON"); } };
    let message = Message.new(parsed);
    let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match conversion { Some(value) => value.body, None() => { return Err("delegation fields must be strings"); } };
    if count(fields) != 2 || fields[0] != "delegate" { return Err("unsupported delegation verb or arity"); }
    if !bounded(fields[1], 128) { return Err("invalid bounded delegated task"); }
    return Ok(fields[1]);
}

// Check the complete Prompt.data encoding, not just its unescaped field values.
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if len(encoded) > 2048 { return "model context exceeds 2048 serialized characters"; }
    return "";
}

flow ledger_error(state: Ledger) -> string {
    if state.steps < 0 || state.steps > 5 || state.calls < 0 || state.calls > 3 ||
        state.tokens < 0 || state.tokens > 6144 { return "invalid shared model ledger"; }
    // Range checks above precede multiplication/addition, preventing overflow.
    if state.calls > state.steps || state.steps > state.calls + 2 ||
        state.tokens != state.calls * 2048 { return "invalid shared model ledger"; }
    return "";
}

public flow charge_call(state: Ledger) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if state.steps >= 5 || state.calls >= 3 || state.tokens > 4096 { return Err("model call reservation exhausted"); }
    return Ok(Ledger { steps = state.steps + 1, calls = state.calls + 1, tokens = state.tokens + 2048 });
}

public flow charge_boundary(state: Ledger) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if state.steps >= 5 || state.steps >= state.calls + 2 { return Err("boundary reservation exhausted"); }
    return Ok(Ledger { steps = state.steps + 1, calls = state.calls, tokens = state.tokens });
}
