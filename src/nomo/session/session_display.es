module nomo.session.session_display;

import std.text.{len, split};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.session.session_state.{Projection, Snapshot, Request, validate};

flow hex(value: u8) -> string { return split("0123456789abcdef", "")[value + 1]; }

// utf8_encode yields valid scalar encodings. Nibble arithmetic stays in u8;
// four-byte scalars become the exact JSON UTF-16 surrogate pair, not UTF-8 bytes.
flow escaped(character: string) -> string {
    let bytes = utf8_encode(character);
    let size = byte_count(bytes);
    let slash = split("\\/", "")[1];
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
    let message = Message.new(projection);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => { return Err("display conversion failed"); } };
    let json = match stringify(value) { Ok(text) => text, Err(_) => { return Err("display JSON failed"); } };
    if len(json) > 131072 || byte_count(utf8_encode(json)) > 131072 { return Err("display encoded limit exceeded"); }
    var output = "";
    var size: usize = 0;
    for character in split(json, "") limit Iterations(131074) {
        let fragment = escaped(character);
        size = size + len(fragment);
        if size > 131072 { return Err("display output limit exceeded"); }
        output = output + fragment;
    }
    return Ok(output);
}
