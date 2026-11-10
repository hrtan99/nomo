module nomo.model.read_protocol;

import nomo.core.large_context.{request_bytes, message_bytes, message_frame_bytes};

import std.text.{char_count as len, len as byte_len, concat, trim, replace, from_char};
import std.collections.len as count;
import nomo.application.decoder_contract.ReadPlanDecoder;
import nomo.core.json.string_fields;
import nomo.core.json.encode as encode_json;
import nomo.core.read_text.{safe, bounded};
import nomo.core.large_context.{child_answer_bytes, child_answer_frame_bytes};
import nomo.model.model_tool_contract.{Action, candidate_error, read_selection_error};

public flow question_error(raw: string) -> string {
    return if bounded(raw, request_bytes()) { "" } else { "question requires 1..65536 safe UTF-8 bytes, not only spaces" };
}

// Decode the native flat string-array representation within its byte envelope.
flow fields(raw: string, maximum: usize) -> Result<Array<string>, string> {
    if raw == "" || byte_len(raw) > maximum { return Err("expected bounded flat JSON string array"); }
    return string_fields(raw, "invalid JSON", "expected string fields");
}

public flow compact_frame(raw: string) -> string {
    let values = match string_fields(raw, "invalid JSON", "expected string fields") { Ok(value) => value, Err(error) => { abort(error); } };
    return match encode_json(values, "action conversion refused", "action encoding refused") { Ok(value) => value, Err(error) => { abort(error); } };
}

public type Utf8ReadPlan = { work: bool };
impl Utf8ReadPlan ~ ReadPlanDecoder {
    flow decode(self, raw: string) -> Result<string, string> {
        let values = match fields(raw, message_frame_bytes()) { Ok(item) => item, Err(error) => { return Err(error); } };
        if count(values) != 2 || values[0] != "delegate" || !bounded(values[1], message_bytes()) { return Err("invalid bounded delegated task"); }
        return Ok(values[1]);
    }
}
public flow decode_plan(raw: string) -> Result<string, string> { let decoder = Utf8ReadPlan { work = false }; return decoder.decode(raw); }
public flow decode_work_plan(raw: string) -> Result<string, string> { let decoder = Utf8ReadPlan { work = true }; return decoder.decode(raw); }

public flow work_plan_rejection(raw: string) -> string {
    let values = match fields(raw, message_frame_bytes()) { Ok(item) => item, Err(_) => { return "unknown"; } };
    if count(values) != 2 || values[0] != "delegate" { return "unknown"; }
    if values[1] == "" || trim(values[1]) == "" { return "blank"; }
    if len(values[1]) > message_bytes() || byte_len(values[1]) > message_bytes() { return "length"; }
    if !bounded(values[1], message_bytes()) { return "unsafe"; }
    return "unknown";
}


public flow answer(raw: string) -> Result<string, string> {
    if !bounded(raw, message_bytes()) { return Err("invalid bounded final answer"); }
    return Ok(raw);
}

// Report only the violated constraint; never display the model's rejected text.
flow child_final(text: string) -> Result<string, string> {
    if len(text) > child_answer_bytes() || byte_len(text) > child_answer_bytes() { return Err("child final exceeds 1048576 UTF-8 bytes"); }
    let line = text;
    if !bounded(line, child_answer_bytes()) { return Err("child final contains unsupported control or formatting characters or is empty"); }
    return Ok(line);
}

public flow decode_child(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let invalid = candidate_error(allowed); if invalid != "" { return Err(invalid); }
    let values = match fields(raw, child_answer_frame_bytes()) { Ok(item) => item, Err(error) => { return Err(error); } };
    if count(values) < 2 || count(values) > 6 { return Err("invalid action field count"); }
    if values[0] == "final" {
        if count(values) != 2 { return Err("child final must contain exactly two fields"); }
        let final = match child_final(values[1]) { Ok(value) => value, Err(error) => { return Err(error); } };
        return Ok(Action { operation = "final", files = [], literal = "", text = final });
    }
    if final_only { return Err("second response must be final"); }
    // fields already checked structural whitespace and string safety above.
    if byte_len(raw) > message_frame_bytes() { return Err("tool action exceeds 8388608 UTF-8 bytes"); }
    if values[0] == "search" && count(values) == 3 && values[2] == "*" {
        let selected = read_selection_error("search", [allowed[0]], values[1], allowed); if selected != "" { return Err(selected); }
        return Ok(Action { operation = "search", files = ["*"], literal = values[1], text = "" });
    }
    var files: Array<string> = []; var literal = "";
    if values[0] == "read" && count(values) == 2 { files = [values[1]]; }
    else if values[0] == "search" && count(values) >= 3 && count(values) <= 6 {
        literal = values[1]; files = [values[2]];
        if count(values) >= 4 { files = files.push(values[3]); }
        if count(values) >= 5 { files = files.push(values[4]); }
        if count(values) >= 6 { files = files.push(values[5]); }
    } else { return Err("unsupported action or arity"); }
    let selected = read_selection_error(values[0], files, literal, allowed);
    if selected != "" { return Err(selected); }
    return Ok(Action { operation = values[0], files = files, literal = literal, text = "" });
}
