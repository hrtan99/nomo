module nomo.harness.model_plan_diagnostic;

import nomo.core.large_context.{edit_response_bytes};

import std.text.{char_count as len, len as byte_len, contains, from_usize, lowercase};
import nomo.tools.edit_encoding.json;

flow phase_name(value: string) -> string {
    for known in ["read-plan", "read-child-action", "read-child-final", "read-aggregate", "edit-plan", "edit-child", "edit-aggregate"] limit Iterations(7) { if value == known { return value; } }
    return "unknown";
}
flow category_name(value: string) -> string {
    for known in ["limit", "control", "frame", "json", "shape", "arity", "verb", "task", "target", "replacement", "summary", "proposal", "field", "files", "literal", "result", "answer", "fence", "object", "prose"] limit Iterations(20) { if value == known { return value; } }
    return "unknown";
}
flow limit(maximum: usize) -> usize { return if maximum > 0 && maximum <= edit_response_bytes() { maximum } else { 384 }; }
// Preserve the historical scalar-count diagnostic while measuring UTF-8 bytes
// only after the response is within the configured scalar bound.
public flow response_error(raw: string, phase: string, category: string, maximum: usize) -> string {
    var bytes = "unmeasured";
    if len(raw) <= limit(maximum) { bytes = from_usize(byte_len(raw)); }
    return "phase=" + phase_name(phase) + " category=" + category_name(category) + " chars=" + from_usize(len(raw)) + " utf8=" + bytes;
}
public flow read_plan_error(raw: string, category: string) -> string { return response_error(raw, "read-plan", category, 384); }
flow header(phase: string, clipped: bool, redacted: bool) -> string {
    return "phase=" + phase_name(phase) + " returned-text clipped=" + if clipped { "true" } else { "false" } +
        " redacted=" + if redacted { "true" } else { "false" } + " text=";
}
flow shown(phase: string, text: string, clipped: bool, redacted: bool) -> string {
    let encoded = match json([text]) { Ok(value) => value, Err(_) => { return header(phase, true, true) + "[\"<unavailable>\"]"; } };
    return header(phase, clipped, redacted) + encoded;
}
// Fixture caller supplies a known nonsecret credential prefix. Empty exclusion
// fails closed. Check the entire raw value before any clipping or formatting.
public flow response_text(raw: string, phase: string, excluded: string, maximum: usize) -> string {
    if excluded == "" || contains(raw, excluded) || contains(raw, "Bearer") || contains(raw, "bearer") || contains(raw, "BEARER") ||
        contains(raw, "Authorization") || contains(raw, "authorization") || contains(raw, "AUTHORIZATION") ||
        contains(raw, "api-key") || contains(raw, "API-Key") || contains(raw, "API-KEY") || contains(raw, "api_key") || contains(raw, "API_KEY") {
        return shown(phase, "<redacted>", false, true);
    }
    if len(raw) > limit(maximum) { return shown(phase, "<omitted:raw-limit>", true, false); }
    let folded = lowercase(raw);
    if contains(folded, "authorization") || contains(folded, "bearer") || contains(folded, "api-key") || contains(folded, "api_key") { return shown(phase, "<redacted>", false, true); }
    var prefix = ""; var size: usize = 4; var clipped = false;
    let maximum_encoded = 384 - len(header(phase, false, false));
    for codepoint in std.text.chars(raw) limit Iterations(32770) { let character = std.text.from_char(codepoint);
        if character != "" {
            let encoded = match json([character]) { Ok(value) => value, Err(_) => { return shown(phase, "<unavailable>", true, true); } };
            let width = len(encoded) - 4;
            if size + width > maximum_encoded { clipped = true; break; }
            prefix = prefix + character; size = size + width;
        }
    }
    return shown(phase, prefix, clipped, false);
}
public flow returned_text(raw: string, excluded: string) -> string { return response_text(raw, "read-plan", excluded, 384); }
