module nomo.session.event_text_codec;

import std.agent.message.Message;
import std.json.{JsonValue, parse, stringify};
import nomo.core.read_text.safe;
import std.text.split;
import nomo.session.redaction.{Policy, text as redact};

// Canonical JSON string notation is reversible for LF, CR, TAB, quotes and
// backslashes. Filtering happens on decoded text before encoding. Unsupported
// or overlong encoded text is refused, never silently truncated.
public type Encoded = { value: string, replacements: usize };

public flow encode(text: string, policy: Policy) -> Result<Encoded, string> {
    let clean = match redact(text, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let converted: Option<Message<JsonValue>> = Message.new(clean.value).cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => { return Err("event text JSON conversion refused"); } };
    let encoded = match stringify(value) { Ok(item) => item, Err(_) => { return Err("event text JSON encoding refused"); } };
    if !safe(encoded, 2048) { return Err("encoded event text unsupported or exceeds bound"); }
    return Ok(Encoded { value = encoded, replacements = clean.replacements });
}

public flow decode(encoded: string, policy: Policy) -> Result<string, string> {
    if !safe(encoded, 2048) { return Err("invalid encoded event text"); }
    let value = match parse(encoded) { Ok(item) => item, Err(_) => { return Err("invalid event text JSON"); } };
    let converted: Option<Message<string>> = Message.new(value).cast<string>();
    let raw = match converted { Some(item) => item.body, None() => { return Err("event text JSON is not a string"); } };
    let canonical = match encode(raw, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    if canonical.replacements != 0 || canonical.value != encoded { return Err("event text is noncanonical or contains a known sensitive literal"); }
    return Ok(raw);
}

// Filter the complete bounded stream before taking a display prefix. If the
// host cannot transfer the complete capture, it supplies an empty stream and
// the truncation flag instead of a potentially sensitive partial literal.
public type Prefix = { value: string, truncated: bool };
public flow encode_prefix(text: string, truncated: bool, policy: Policy) -> Result<Prefix, string> {
    let clean = match redact(text, policy) { Ok(item) => item.value, Err(error) => { return Err(error); } };
    var selected = ""; var seen: usize = 0; var clipped = truncated;
    for character in split(clean, "") limit Iterations(10242) {
        if character != "" { if seen < 128 { selected = selected + character; } else { clipped = true; } seen = seen + 1; }
    }
    let encoded = match encode(selected, policy) { Ok(item) => item.value, Err(error) => { return Err(error); } };
    return Ok(Prefix { value = encoded, truncated = clipped });
}
