module nomo.tools.edit_encoding;

import std.text.{char_count as len, char_get, concat, from_char, join};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.crypto.sha256;
import std.agent.message.Message;
import nomo.core.large_context.{file_bytes, edit_json_bytes};

// All callers produce a nibble by division/modulo or valid UTF-8 bit groups.
flow nibble(value: u8) -> string {
    return match char_get("0123456789abcdef", value) { Some(character) => from_char(character), None() => "?" };
}

flow byte_hex(value: u8) -> string { return nibble(value / 16) + nibble(value % 16); }
flow unit_hex(a: u8, b: u8, c: u8, d: u8) -> string {
    return from_char('\\') + "u" + nibble(a) + nibble(b) + nibble(c) + nibble(d);
}

// Serialize each scalar to printable ASCII JSON, including surrogate pairs.
// Escaping all non-ASCII also covers C1, bidi and other terminal controls.
flow scalar(value: string) -> Result<string, string> {
    let data = utf8_encode(value); let size = byte_count(data);
    if size == 1 {
        let number = data[0];
        if number == 34 { return Ok(from_char('\\') + "\""); }
        if number == 92 { return Ok(from_char('\\') + from_char('\\')); }
        if number >= 32 && number <= 126 { return Ok(value); }
        return Ok(from_char('\\') + "u00" + byte_hex(number));
    }
    if size == 2 {
        let a: u8 = data[0] - 192; let b: u8 = data[1] - 128;
        return Ok(unit_hex(0, a / 4, (a % 4) * 4 + b / 16, b % 16));
    }
    if size == 3 {
        let a: u8 = data[0] - 224; let b: u8 = data[1] - 128; let c: u8 = data[2] - 128;
        return Ok(unit_hex(a, b / 4, (b % 4) * 4 + c / 16, c % 16));
    }
    if size == 4 {
        let a: u8 = data[0] - 240; let b: u8 = data[1] - 128;
        let c: u8 = data[2] - 128; let d: u8 = data[3] - 128;
        let top: u8 = a * 4 + b / 16 - 1;
        let n3: u8 = b % 16; let n2: u8 = c / 4;
        let n1: u8 = (c % 4) * 4 + d / 16; let n0: u8 = d % 16;
        let high = unit_hex(13, 8 + top / 4, (top % 4) * 4 + n3 / 4, (n3 % 4) * 4 + n2 / 4);
        let low = unit_hex(13, 12 + n2 % 4, n1, n0);
        return Ok(high + low);
    }
    return Err("invalid Unicode scalar encoding");
}

flow quoted(value: string) -> Result<string, string> {
    if len(value) > file_bytes() { return Err("edit JSON field exceeds bound"); }
    var pieces: Array<string> = []; var chunk = ""; var size: usize = 1;
    for codepoint in std.text.chars(value) limit Iterations(262146) { let character = std.text.from_char(codepoint);
        if character != "" {
            let escaped = match scalar(character) { Ok(item) => item, Err(error) => { return Err(error); } };
            size = size + len(escaped); if size > edit_json_bytes() - 2 { return Err("edit JSON output exceeds bound"); }
            chunk = chunk + escaped;
            if len(chunk) >= 4096 { pieces = pieces.push(chunk); chunk = ""; }
        }
    }
    return Ok("\"" + concat(pieces) + chunk + "\"");
}

public flow json(values: Array<string>) -> Result<string, string> {
    if count(values) > 16 { return Err("edit JSON field count exceeds bound"); }
    var fields: Array<string> = []; var size: usize = 2;
    for value in values limit Iterations(16) {
        let encoded = match quoted(value) { Ok(item) => item, Err(error) => { return Err(error); } };
        size = size + len(encoded) + if count(fields) == 0 { 0 } else { 1 };
        if size > edit_json_bytes() { return Err("edit JSON output exceeds bound"); }
        fields = fields.push(encoded);
    }
    return Ok("[" + join(fields, ",") + "]");
}

public flow object(keys: Array<string>, values: Array<string>) -> Result<string, string> {
    if count(keys) != count(values) || count(keys) > 16 { return Err("edit JSON key/value count invalid"); }
    var fields: Array<string> = []; var size: usize = 2; var index: usize = 0; var seen: Array<string> = [];
    while index < count(keys) limit Iterations(16) {
        for prior in seen limit Iterations(16) { if prior == keys[index] { return Err("duplicate edit JSON key"); } }
        seen = seen.push(keys[index]);
        let key = match quoted(keys[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        let value = match quoted(values[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        let field = key + ":" + value;
        size = size + len(field) + if count(fields) == 0 { 0 } else { 1 };
        if size > edit_json_bytes() { return Err("edit JSON output exceeds bound"); }
        fields = fields.push(field);
        index = index + 1;
    }
    return Ok("{" + join(fields, ",") + "}");
}

public flow digest(text: string) -> Result<string, string> {
    let message = Message.new(sha256(utf8_encode(text)));
    let converted: Option<Message<bytes>> = message.cast<bytes>();
    let data = match converted { Some(value) => value.body, None() => { return Err("SHA-256 representation refused"); } };
    if byte_count(data) != 32 { return Err("invalid SHA-256 length"); }
    var parts: Array<string> = []; var index: usize = 0;
    while index < 32 limit Iterations(32) { parts = parts.push(byte_hex(data[index])); index = index + 1; }
    return Ok(concat(parts));
}
