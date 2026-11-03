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
