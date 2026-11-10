module nomo.session.session_display;

import nomo.core.json.encode as encode_json;

import std.text.{char_count as len, len as byte_len, char_get, concat, from_char, is_ascii};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;


import nomo.session.session_state.{Projection, Snapshot, Request, validate};

flow hex(value: u8) -> string {
    return match char_get("0123456789abcdef", value) { Some(character) => from_char(character), None() => "?" };
}

// utf8_encode yields valid scalar encodings. Nibble arithmetic stays in u8;
// four-byte scalars become the exact JSON UTF-16 surrogate pair, not UTF-8 bytes.
public flow escaped(character: string) -> string {
    let bytes = utf8_encode(character);
    let size = byte_count(bytes);
    let slash = from_char('\\');
    if size == 0 { return ""; }
    let first = bytes[0];
    if size == 1 {
        if first >= 32 && first < 127 { return character; }
        return slash + "u00" + hex(first / 16) + hex(first % 16);
    }
    let second = bytes[1] - 128;
    if size == 2 {
        return slash + "u0" + hex((first - 192) / 4) + hex((first % 4) * 4 + second / 16) + hex(second % 16);
    }
    let third = bytes[2] - 128;
    if size == 3 {
        return slash + "u" + hex(first - 224) + hex(second / 4) + hex((second % 4) * 4 + third / 16) + hex(third % 16);
    }
    let fourth = bytes[3] - 128;
    var high = 8 + (first - 240);
    var low = second * 4 + third / 16;
    if low < 64 { high = high - 1; low = low + 192; }
    else { low = low - 64; }
    return slash + "ud" + hex(high) + hex(low / 16) + hex(low % 16) + slash + "ud" +
        hex(12 + (third % 16) / 4) + hex((third % 4) * 4 + fourth / 16) + hex(fourth % 16);
}

public flow display(projection: Projection) -> Result<string, string> {
    var lifecycle = "active";
    if projection.disposition == "recovery-required" { lifecycle = "recovery-required"; }
    else if projection.history.stopped { lifecycle = "stopped"; }
    let saved = Snapshot { format = 1, session_id = projection.session_id, generation = projection.generation,
        mode = projection.mode, binding = projection.binding, lifecycle = lifecycle, history = projection.history,
        references = projection.references, operations = projection.operations, original_caps = projection.original_caps,
        current_caps = projection.caps, ledger = projection.ledger };
    let requested = Request { session_id = projection.session_id, mode = projection.mode,
        binding = projection.binding, caps = projection.caps };
    match validate(saved, requested) {
        Ok(checked) => { if checked != projection { return Err("inconsistent display projection"); } },
        Err(_) => { return Err("invalid display projection"); }
    }
    let json = match encode_json(projection, "display conversion failed", "display JSON failed") { Ok(value) => value, Err(error) => { return Err(error); } };
    return ascii_json(json, 131072, "display encoded limit exceeded", "display output limit exceeded");
}

public flow ascii_json(json: string, maximum: usize, encoded_error: string, display_error: string) -> Result<string, string> {
    return ascii_json_with(json, 131072, maximum, encoded_error, display_error);
}

// The standard JSON codec owns JSON framing and string escaping. This final
// terminal-safety pass only converts remaining non-ASCII scalars to JSON
// Unicode escapes; chunked std.text.concat avoids quadratic large-string growth.
public flow ascii_json_with(json: string, encoded_maximum: usize, maximum: usize, encoded_error: string, display_error: string) -> Result<string, string> {
    if len(json) > encoded_maximum || byte_len(json) > encoded_maximum { return Err(encoded_error); }
    // stringify() already escapes every ASCII control in its compact output,
    // so the standard constant-time ASCII query is the complete fast-path
    // check; rescanning every byte duplicated the codec and made MiB previews
    // interpreter-bound.
    if is_ascii(json) { if byte_len(json) > maximum { return Err(display_error); } return Ok(json); }
    var pieces: Array<string> = []; var chunk = ""; var size: usize = 0;
    // The largest caller accepts 16 Mi scalar inputs; keep its established
    // iteration envelope even when smaller callers select tighter byte bounds.
    for codepoint in std.text.chars(json) limit Iterations(134217730) { let character = std.text.from_char(codepoint);
        let fragment = escaped(character); size = size + len(fragment);
        if size > maximum { return Err(display_error); }
        chunk = chunk + fragment;
        if len(chunk) >= 4096 { pieces = pieces.push(chunk); chunk = ""; }
    }
    if chunk != "" { pieces = pieces.push(chunk); }
    return Ok(concat(pieces));
}
