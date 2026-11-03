module nomo.core.text;

import std.text.{split, contains, len, trim, starts_with};
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;

public flow printable(text: string) -> bool {
    let allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    for character in split(text, "") limit Iterations(1026) {
        if character != "" && !contains(allowed, character) { return false; }
    }
    return true;
}

public flow input_error(raw: string) -> string {
    if len(raw) > 1024 { return "input exceeds 1024 characters"; }
    let request = trim(raw);
    if request == "" { return "empty input"; }
    if !printable(request) { return "expected printable ASCII single-line input"; }
    if starts_with(request, "/") { return "unsupported command; use /help or /exit in line mode"; }
    return "";
}

// Reuse the checked JSON conversion while preserving each caller's limit and units.
public flow context_json_error(value: Option<Message<JsonValue>>, maximum: usize, bytes: bool, overflow: string) -> string {
    let json = match value { Some(item) => item.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(item) => item, Err(_) => { return "context JSON refused"; } };
    if (if bytes { byte_count(utf8_encode(encoded)) } else { len(encoded) }) > maximum { return overflow; }
    return "";
}

// Bound a flat JSON string array before its caller invokes the JSON parser.
public flow flat_string_frame(raw: string, maximum: usize, exact: bool) -> bool {
    if len(raw) > 65536 || byte_count(utf8_encode(raw)) > 65536 { return false; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0; let slash = split("\\/", "")[1];
    for character in split(raw, "") limit Iterations(65538) {
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " || character == "\t" || character == "\r" || character == "\n" {
        } else if character == "[" {
            if opened || closed { return false; } opened = true;
        } else if character == "]" {
            if !opened || closed { return false; } closed = true;
        } else if character == "\"" {
            if !opened || closed { return false; }
            leaves = leaves + 1; if leaves > maximum { return false; } quoted = true;
        } else if character != "," || !opened || closed { return false; }
    }
    return opened && closed && !quoted && (!exact || leaves == maximum);
}


public flow hex_digest(value: string) -> bool {
    if len(value) != 64 { return false; }
    for character in split(value, "") limit Iterations(66) {
        if character != "" && !contains("0123456789abcdef", character) { return false; }
    }
    return true;
}
