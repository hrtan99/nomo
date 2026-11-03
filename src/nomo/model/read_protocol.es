module nomo.model.read_protocol;

import std.text.{len, split, trim};
import std.collections.len as count;
import std.json.parse;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import std.agent.message.Message;
import nomo.core.read_text.{safe, bounded};
import nomo.model.model_tool_contract.{Action, allowed_error, read_selection_error};

public flow question_error(raw: string) -> string {
    return if bounded(raw, 128) { "" } else { "question requires 1..128 safe UTF-8 bytes, not only spaces" };
}

// This protocol is scoped to the new non-durable read-only entry. Limits are
// UTF-8 bytes, including serialized JSON, rather than just scalar counts.
flow frame(raw: string, maximum: usize) -> bool {
    if raw == "" || maximum == 0 || maximum > 4096 || len(raw) > maximum || byte_count(utf8_encode(raw)) > maximum { return false; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0; let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(4098) {
        if quoted {
            if character != "" && !safe(character, 4) { return false; }
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " || character == "\n" || character == "\r" || character == "\t" {
        } else if character == "[" {
            if opened || closed { return false; } opened = true;
        } else if character == "]" {
            if !opened || closed { return false; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return false; }
            leaves = leaves + 1; if leaves > 6 { return false; } quoted = true;
        } else if character != "," || !opened || closed { return false; }
    }
    return opened && closed && !quoted;
}

flow fields(raw: string, maximum: usize) -> Result<Array<string>, string> {
    if !frame(raw, maximum) { return Err("expected bounded flat JSON string array"); }
    let value = match parse(raw) { Ok(item) => item, Err(_) => { return Err("invalid JSON"); } };
    let converted: Option<Message<Array<string>>> = Message.new(value).cast<Array<string>>();
    return match converted { Some(item) => Ok(item.body), None() => Err("expected string fields") };
}

// Call only after decoding a valid frame. Keep string bytes and escapes intact.
public flow compact_frame(raw: string) -> string {
    var result = ""; var quoted = false; var escaped = false;
    let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(1154) {
        if quoted {
            result = result + character;
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "\"" {
            quoted = true; result = result + character;
        } else if character != "" && character != " " && character != "\n" && character != "\r" && character != "\t" {
            result = result + character;
        }
    }
    return result;
}

public flow decode_plan(raw: string) -> Result<string, string> {
    let values = match fields(raw, 384) { Ok(item) => item, Err(error) => { return Err(error); } };
    if count(values) != 2 || values[0] != "delegate" || !bounded(values[1], 128) {
        return Err("invalid bounded delegated task");
    }
    return Ok(values[1]);
}

// Work can carry a longer delegation while the original read/chat limit stays 128 bytes.
public flow decode_work_plan(raw: string) -> Result<string, string> {
    let values = match fields(raw, 4096) { Ok(item) => item, Err(error) => { return Err(error); } };
    if count(values) != 2 || values[0] != "delegate" || !bounded(values[1], 512) {
        return Err("invalid bounded delegated task");
    }
    return Ok(values[1]);
}

// Classify only the violated bound; do not expose the rejected response.
public flow work_plan_rejection(raw: string) -> string {
    let values = match fields(raw, 4096) { Ok(item) => item, Err(_) => { return "unknown"; } };
    if count(values) != 2 || values[0] != "delegate" { return "unknown"; }
    if values[1] == "" || trim(values[1]) == "" { return "blank"; }
    if len(values[1]) > 512 || byte_count(utf8_encode(values[1])) > 512 { return "length"; }
    if !safe(values[1], 512) { return "unsafe"; }
    return "unknown";
}


public flow answer(raw: string) -> Result<string, string> {
    if !bounded(raw, 512) { return Err("invalid bounded final answer"); }
    return Ok(raw);
}

// Report only the violated constraint; never display the model's rejected text.
flow child_final_error(text: string) -> string {
    if text == "" || trim(text) == "" { return "child final text is empty"; }
    if len(text) > 256 || byte_count(utf8_encode(text)) > 256 { return "child final exceeds 256 UTF-8 bytes"; }
    if !safe(text, 256) { return "child final contains unsupported control or formatting characters"; }
    return "";
}

public flow decode_child(raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> {
    let invalid = allowed_error(allowed); if invalid != "" { return Err(invalid); }
    let values = match fields(raw, 1152) { Ok(item) => item, Err(error) => { return Err(error); } };
    if count(values) < 2 || count(values) > 6 { return Err("invalid action field count"); }
    if values[0] == "final" {
        if count(values) != 2 { return Err("child final must contain exactly two fields"); }
        let invalid = child_final_error(values[1]); if invalid != "" { return Err(invalid); }
        return Ok(Action { operation = "final", files = [], literal = "", text = values[1] });
    }
    if final_only { return Err("second response must be final"); }
    // fields already checked structural whitespace and string safety above.
    if byte_count(utf8_encode(raw)) > 384 { return Err("tool action exceeds 384 UTF-8 bytes"); }
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
