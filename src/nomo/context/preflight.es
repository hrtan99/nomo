module nomo.context.preflight;

import std.text.len;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.model.tool_context.{Context, bounded_context_error};

public enum Refusal { InvalidLimit, InvalidContext, InvalidText, Encoding, TooLarge }
public type Measurement = { encoded: string, encoded_bytes: usize, tokens: Option<usize> };

// Only the closed Context/string entry points below reach this encoder. Their
// JSON leaves are strings/bools, so the JsonValue roundtrip preserves the typed
// Prompt.data representation. Numeric/bytes/enum/generic input is unsupported.
flow encoded_measure(json: JsonValue, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    let encoded = match stringify(json) {
        Ok(text) => text,
        Err(_) => { return Err(Refusal.Encoding); },
    };
    // A scalar takes at least one UTF-8 byte. Bound the extra byte allocation.
    if len(encoded) > maximum_bytes { return Err(Refusal.TooLarge); }
    let size = byte_count(utf8_encode(encoded));
    if size > maximum_bytes { return Err(Refusal.TooLarge); }
    return Ok(Measurement { encoded = encoded, encoded_bytes = size, tokens = None() });
}

// Measure the same concrete value the caller supplies to Prompt.data. Semantic
// confirmation and the existing stage budget/admission guards remain required.
public flow measure_context(context: Context, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    if maximum_bytes > 262144 { return Err(Refusal.InvalidLimit); }
    if bounded_context_error(context) != "" { return Err(Refusal.InvalidContext); }
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion {
        Some(converted) => converted.body,
        None() => { return Err(Refusal.Encoding); },
    };
    return encoded_measure(json, maximum_bytes);
}

// This scalar ceiling bounds source allocation before conversion. It is not an
// estimate of encoded size or Provider tokens; escaping/UTF-8 are measured below.
public flow measure_text(text: string, maximum_bytes: usize) -> Result<Measurement, Refusal> {
    if maximum_bytes > 262144 { return Err(Refusal.InvalidLimit); }
    if len(text) > 262144 { return Err(Refusal.InvalidText); }
    let message = Message.new(text);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion {
        Some(converted) => converted.body,
        None() => { return Err(Refusal.Encoding); },
    };
    return encoded_measure(json, maximum_bytes);
}
