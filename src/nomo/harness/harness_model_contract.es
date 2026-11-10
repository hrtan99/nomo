module nomo.harness.harness_model_contract;

import nomo.core.large_context.{message_bytes, message_frame_bytes, context_bytes};

import nomo.application.decoder_contract.ReadPlanDecoder;
import nomo.core.json.{FieldError, decode_fields as json_fields};

import std.text.{char_count as len, trim, from_char};
import std.collections.len as count;
import std.json.JsonValue;
import std.agent.message.Message;
import nomo.core.text.{printable, context_json_error};
import nomo.harness.model_plan_diagnostic.{read_plan_error, response_error};

public type Context = { phase: string, request: string, task: string, result: string };
public type Ledger = { steps: i32, calls: i32, tokens: i32 };

public flow fresh() -> Ledger { return Ledger { steps = 0, calls = 0, tokens = 0 }; }

public flow bounded(text: string, maximum: usize) -> bool {
    return maximum > 0 && maximum <= message_frame_bytes() && len(text) > 0 && len(text) <= maximum &&
        printable(text) && trim(text) != "";
}

// Both callers bound raw characters before this shared flat-frame scan.
// Only the current read plan permits standard JSON whitespace outside strings.
flow frame_error(raw: string, formatting: bool) -> string {
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0;
    let slash = from_char('\\');
    for codepoint in std.text.chars(raw) limit Iterations(8388610) { let character = std.text.from_char(codepoint);
        let whitespace = character == " " || character == "\t" || character == "\r" || character == "\n";
        if !printable(character) && !(formatting && !quoted && whitespace) { return "control"; }
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " || (formatting && whitespace) {
        } else if character == "[" {
            if opened || closed { return if formatting && !closed { "shape" } else { "frame" }; }
            opened = true;
        } else if character == "]" {
            if !opened || closed { return "frame"; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return if formatting && !closed { "shape" } else { "frame" }; }
            leaves = leaves + 1; if !formatting && leaves > 2 { return "frame"; } quoted = true;
        } else if character != "," || !opened || closed {
            if formatting && !closed && (character == "{" || character == "-" || character == "t" || character == "f" ||
                character == "n" || character == "0" || character == "1" || character == "2" || character == "3" ||
                character == "4" || character == "5" || character == "6" || character == "7" || character == "8" || character == "9") { return "shape"; }
            return "frame";
        }
    }
    return if opened && closed && !quoted { "" } else { "frame" };
}

public type AsciiReadPlan = { compatible: bool };
impl AsciiReadPlan ~ ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> {
        if self.compatible {
            if len(raw) == 0 || len(raw) > message_frame_bytes() { return Err(read_plan_error(raw, "limit")); }
            let framed = frame_error(raw, true); if framed != "" { return Err(read_plan_error(raw, framed)); }
        } else if !bounded(raw, message_frame_bytes()) || frame_error(raw, false) != "" { return Err("expected bounded flat single-line delegation JSON"); }
        let fields = match json_fields(raw) {
            Ok(value) => value,
            Err(FieldError.Json) => { return Err(if self.compatible { read_plan_error(raw, "json") } else { "invalid delegation JSON" }); }
            Err(FieldError.Shape) => { return Err(if self.compatible { read_plan_error(raw, "shape") } else { "delegation fields must be strings" }); }
        };
        if count(fields) != 2 { return Err(if self.compatible { read_plan_error(raw, "arity") } else { "unsupported delegation verb or arity" }); }
        if fields[0] != "delegate" { return Err(if self.compatible { read_plan_error(raw, "verb") } else { "unsupported delegation verb or arity" }); }
        if !bounded(fields[1], message_bytes()) { return Err(if self.compatible { read_plan_error(raw, "task") } else { "invalid bounded delegated task" }); }
        return Ok(fields[1]);
    }
}
public flow decode_plan(raw: string) -> Result<string, string> { let decoder = AsciiReadPlan { compatible = false }; return decoder.decode(raw); }
public flow decode_read_plan(raw: string) -> Result<string, string> { let decoder = AsciiReadPlan { compatible = true }; return decoder.decode(raw); }

public flow read_aggregate_error(raw: string) -> string {
    if len(raw) == 0 || len(raw) > message_bytes() { return response_error(raw, "read-aggregate", "limit", 512); }
    if !printable(raw) { return response_error(raw, "read-aggregate", "control", 512); }
    if trim(raw) == "" { return response_error(raw, "read-aggregate", "summary", 512); }
    return "";
}

// Check the complete Prompt.data encoding, not just its unescaped field values.
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(message.cast<JsonValue>(), context_bytes(), false, "model context exceeds 33554432 serialized characters");
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
