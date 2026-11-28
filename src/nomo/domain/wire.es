module nomo.domain.wire;

import nomo.domain.limits.{edit_json_bytes, file_bytes};
import std.agent.message.Message;
import std.bytes.len;
import std.codec.text.utf8_encode;
import std.collections.unique;
import std.crypto.sha256;
import std.json.{JsonValue, parse, stringify};
import std.text.{TextBuilder, char_count, char_get, concat, from_char, is_ascii, join, len as text_len};

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
    let data = utf8_encode(value); let size = len(data);
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
    if text_len(value) > file_bytes() { return Err("edit JSON field exceeds bound"); }
    // The standard serializer handles the overwhelmingly common ASCII file
    // path in native code.  Retain explicit Unicode escaping below so terminal
    // previews never emit bidi, C1 or other invisible non-ASCII controls.
    if is_ascii(value) {
        let encoded = match encode(value, "edit JSON conversion refused", "edit JSON encoding refused") {
            Ok(item) => item, Err(error) => { return Err(error); }
        };
        if text_len(encoded) > edit_json_bytes() { return Err("edit JSON output exceeds bound"); }
        return Ok(encoded);
    }
    var output = TextBuilder.new(); var size: usize = 1;
    @limits([Iterations(1048578)]) for codepoint in std.text.chars(value) { let character = std.text.from_char(codepoint);
        if character != "" {
            let escaped = match scalar(character) { Ok(item) => item, Err(error) => { return Err(error); } };
            size = size + text_len(escaped); if size > edit_json_bytes() - 2 { return Err("edit JSON output exceeds bound"); }
            output.append(escaped);
        }
    }
    return Ok("\"" + output.build() + "\"");
}

public flow json(values: Array<string>) -> Result<string, string> {
    if values.len() > 16 { return Err("edit JSON field count exceeds bound"); }
    var fields: Array<string> = []; var size: usize = 2;
    @limits([Iterations(16)]) for value in values {
        let encoded = match quoted(value) { Ok(item) => item, Err(error) => { return Err(error); } };
        size = size + text_len(encoded) + if fields.len() == 0 { 0 } else { 1 };
        if size > edit_json_bytes() { return Err("edit JSON output exceeds bound"); }
        fields = fields.push(encoded);
    }
    return Ok("[" + join(fields, ",") + "]");
}

public flow object(keys: Array<string>, values: Array<string>) -> Result<string, string> {
    if keys.len() != values.len() || keys.len() > 16 { return Err("edit JSON key/value count invalid"); }
    if unique(keys).len() != keys.len() { return Err("duplicate edit JSON key"); }
    var fields: Array<string> = []; var size: usize = 2; var index: usize = 0;
    @limits([Iterations(16)]) while index < keys.len() {
        let key = match quoted(keys[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        let value = match quoted(values[index]) { Ok(item) => item, Err(error) => { return Err(error); } };
        let field = key + ":" + value;
        size = size + text_len(field) + if fields.len() == 0 { 0 } else { 1 };
        if size > edit_json_bytes() { return Err("edit JSON output exceeds bound"); }
        fields = fields.push(field);
        index = index + 1;
    }
    return Ok("{" + join(fields, ",") + "}");
}

public flow digest(text: string) -> Result<string, string> {
    let data = sha256(utf8_encode(text));
    return Ok(concat(data.iter().map(value => byte_hex(value)).collect()));
}

// Keep the concrete input type and the caller's fixed refusal diagnostics.
public flow encode<T>(value: T, conversion_error: string, encoding_error: string) -> Result<string, string> ![] {
    let converted: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    let json = match converted { Some(item) => item.body, None() => { return Err(conversion_error); } };
    return match stringify(json) { Ok(text) => Ok(text), Err(_) => Err(encoding_error) };
}

public enum FieldError { Json, Shape }

// Framing and domain limits belong to each protocol; JSON unescaping is shared.
public flow decode_fields(raw: string) -> Result<Array<string>, FieldError> ![] {
    let value = match parse(raw) { Ok(item) => item, Err(_) => { return Err(FieldError.Json); } };
    let converted: Option<Message<Array<string>>> = Message.new(value).cast<Array<string>>();
    return match converted { Some(item) => Ok(item.body), None() => Err(FieldError.Shape) };
}

public flow string_fields(raw: string, json_error: string, shape_error: string) -> Result<Array<string>, string> ![] {
    return match decode_fields(raw) { Ok(value) => Ok(value), Err(FieldError.Json) => Err(json_error), Err(FieldError.Shape) => Err(shape_error) };
}

flow hex(value: u8) -> string {
    return match char_get("0123456789abcdef", value) { Some(character) => from_char(character), None() => "?" };
}

// utf8_encode yields valid scalar encodings. Nibble arithmetic stays in u8;
// four-byte scalars become the exact JSON UTF-16 surrogate pair, not UTF-8 bytes.
public flow escaped(character: string) -> string {
    let bytes = utf8_encode(character);
    let size = len(bytes);
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

public flow ascii_json(json: string, maximum: usize, encoded_error: string, display_error: string) -> Result<string, string> {
    return ascii_json_with(json, 131072, maximum, encoded_error, display_error);
}

// The standard JSON codec owns JSON framing and string escaping. This final
// terminal-safety pass only converts remaining non-ASCII scalars to JSON
// Unicode escapes; chunked std.text.concat avoids quadratic large-string growth.
public flow ascii_json_with(json: string, encoded_maximum: usize, maximum: usize, encoded_error: string, display_error: string) -> Result<string, string> {
    if char_count(json) > encoded_maximum || text_len(json) > encoded_maximum { return Err(encoded_error); }
    // stringify() already escapes every ASCII control in its compact output,
    // so the standard constant-time ASCII query is the complete fast-path
    // check; rescanning every byte duplicated the codec and made MiB previews
    // interpreter-bound.
    if is_ascii(json) { if text_len(json) > maximum { return Err(display_error); } return Ok(json); }
    var output = TextBuilder.new(); var size: usize = 0;
    // The largest caller accepts 16 Mi scalar inputs; keep its established
    // iteration envelope even when smaller callers select tighter byte bounds.
    @limits([Iterations(134217730)]) for codepoint in std.text.chars(json) { let character = std.text.from_char(codepoint);
        let fragment = escaped(character); size = size + char_count(fragment);
        if size > maximum { return Err(display_error); }
        output.append(fragment);
    }
    return Ok(output.build());
}
