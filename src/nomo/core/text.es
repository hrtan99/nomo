module nomo.core.text;

import nomo.core.large_context.{message_bytes};

import nomo.core.large_context.{request_bytes, context_bytes};

import std.text.{contains, char_count as len, len as byte_len, trim, starts_with, from_char, is_ascii};
import nomo.core.read_text.safe;
import nomo.core.large_context.event_bytes;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;

public flow printable(text: string) -> bool {
    return is_ascii(text) && safe(text, event_bytes());
}

public flow input_error(raw: string) -> string {
    if len(raw) > message_bytes() { return "input exceeds 1048576 characters"; }
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
    if (if bytes { byte_len(encoded) } else { len(encoded) }) > maximum { return overflow; }
    return "";
}

// Bound a flat JSON string array before its caller invokes the JSON parser.
public flow flat_string_frame(raw: string, maximum: usize, exact: bool) -> bool {
    if len(raw) > context_bytes() || byte_len(raw) > context_bytes() { return false; }
    var opened = false; var closed = false; var quoted = false; var escaped = false;
    var leaves: usize = 0; let slash = from_char('\\');
    for codepoint in std.text.chars(raw) limit Iterations(33554434) { let character = std.text.from_char(codepoint);
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
    for codepoint in std.text.chars(value) limit Iterations(66) { let character = std.text.from_char(codepoint);
        if character != "" && !contains("0123456789abcdef", character) { return false; }
    }
    return true;
}
