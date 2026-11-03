module nomo.session.event_text_codec;

import std.agent.message.Message;
import std.json.{JsonValue, parse, stringify};
import nomo.core.read_text.safe;
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
