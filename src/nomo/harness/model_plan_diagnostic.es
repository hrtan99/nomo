module nomo.harness.model_plan_diagnostic;

import std.text.{len, contains, split, to_string_usize, lowercase};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.edit_encoding.json;

// The public std has no borrowing UTF-8 byte length or bounded string slice.
// Refuse oversized data before encoding/splitting; never guess its byte count.
public flow read_plan_error(raw: string, category: string) -> string {
    var bytes = "unmeasured";
    if len(raw) <= 384 { bytes = to_string_usize(byte_count(utf8_encode(raw))); }
    return "phase=read-plan category=" + category + " chars=" + to_string_usize(len(raw)) + " utf8=" + bytes;
}
flow shown(text: string, clipped: bool, redacted: bool) -> string {
    let encoded = match json([text]) { Ok(value) => value, Err(_) => { return "phase=read-plan returned-text clipped=true redacted=true text=[\"<unavailable>\"]"; } };
    return "phase=read-plan returned-text clipped=" + if clipped { "true" } else { "false" } +
        " redacted=" + if redacted { "true" } else { "false" } + " text=" + encoded;
}
// Fixture caller supplies a known nonsecret credential prefix. Empty exclusion
// fails closed. Check the entire raw value before any clipping or formatting.
public flow returned_text(raw: string, excluded: string) -> string {
    if excluded == "" || contains(raw, excluded) || contains(raw, "Bearer") || contains(raw, "bearer") || contains(raw, "BEARER") ||
        contains(raw, "Authorization") || contains(raw, "authorization") || contains(raw, "AUTHORIZATION") ||
        contains(raw, "api-key") || contains(raw, "API-Key") || contains(raw, "API-KEY") || contains(raw, "api_key") || contains(raw, "API_KEY") {
        return shown("<redacted>", false, true);
    }
    if len(raw) > 384 { return shown("<omitted:raw-limit>", true, false); }
    let folded = lowercase(raw);
    if contains(folded, "authorization") || contains(folded, "bearer") || contains(folded, "api-key") || contains(folded, "api_key") { return shown("<redacted>", false, true); }
    var prefix = ""; var size: usize = 4; var clipped = false;
    for character in split(raw, "") limit Iterations(386) {
        if character != "" {
            let encoded = match json([character]) { Ok(value) => value, Err(_) => { return shown("<unavailable>", true, true); } };
            let width = len(encoded) - 4;
            if size + width > 320 { clipped = true; break; }
            prefix = prefix + character; size = size + width;
        }
    }
    return shown(prefix, clipped, false);
}
