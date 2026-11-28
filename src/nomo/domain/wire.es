module nomo.domain.wire;

import nomo.domain.limits.{edit_json_bytes, file_bytes};
import std.agent.message.Message;
import std.codec.text.utf8_encode;
import std.collections.{Map, unique};
import std.core.Index;
import std.crypto.sha256;
import std.json.{JsonValue, parse, stringify};
import std.text.{TextBuilder, char_count, char_get, concat, from_char, is_ascii, join, len};

// All callers produce a nibble by division/modulo of a byte or Unicode scalar.
flow nibble<I ~ Index>(value: I) -> string {
    return match char_get("0123456789abcdef", value) {
        Some(character) => from_char(character),
        None() => "?"
    };
}

flow byte_hex(value: u8) -> string {
    return nibble(value / 16) + nibble(value % 16);
}

flow unit_hex(value: u32) -> string {
    return from_char('\\') + "u" + nibble(value / 4096) + nibble(value / 256 % 16)
        + nibble(value / 16 % 16) + nibble(value % 16);
}

flow unicode_escape(value: u32) -> string {
    if value <= 65535 {
        return unit_hex(value);
    }
    let offset = value - 65536;
    return unit_hex(55296 + offset / 1024) + unit_hex(56320 + offset % 1024);
}

// Serialize each scalar to printable ASCII JSON, including surrogate pairs.
// Escaping all non-ASCII also covers C1, bidi and other terminal controls.
flow scalar(value: char, quoted: bool) -> string {
    let code = value.to_u32();
    if quoted && (code == 34 || code == 92) {
        return from_char('\\') + from_char(value);
    }
    return if code >= 32 && code <= 126 {
        from_char(value)
    } else {
        unicode_escape(code)
    };
}

// Width of a scalar quoted alone, matching the existing per-scalar previews.
// ASCII fields use std's short escapes; complete mixed-Unicode fields still
// use quoted()'s long control escapes and are encoded only after selection.
public flow json_scalar_width(value: char) -> usize {
    let code = value.to_u32();
    if code == 34 || code == 92 || code == 8 || code == 9 || code == 10 || code == 12 || code == 13 {
        return 2;
    }
    if code < 32 || code >= 128 {
        return if code <= 65535 {
            6
        } else {
            12
        };
    }
    return 1;
}

flow quoted(value: string) -> Result<string, string> {
    if len(value) > file_bytes() {
        return Err("edit JSON field exceeds bound");
    }
    // The standard serializer handles the overwhelmingly common ASCII file
    // path in native code.  Retain explicit Unicode escaping below so terminal
    // previews never emit bidi, C1 or other invisible non-ASCII controls.
    if is_ascii(value) {
        let encoded = match encode(value, "edit JSON conversion refused", "edit JSON encoding refused") {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        if len(encoded) > edit_json_bytes() {
            return Err("edit JSON output exceeds bound");
        }
        return Ok(encoded);
    }
    var output = TextBuilder.new();
    var size: usize = 1;
    @limits([Iterations(1048578)]) for codepoint in std.text.chars(value) {
        let escaped = scalar(codepoint, true);
        size = size + len(escaped);
        if size > edit_json_bytes() - 2 {
            return Err("edit JSON output exceeds bound");
        }
        output.append(escaped);
    }
    return Ok("\"" + output.build() + "\"");
}

public flow json(values: Array<string>) -> Result<string, string> {
    if values.len() > 16 {
        return Err("edit JSON field count exceeds bound");
    }
    var fields: Array<string> = [];
    var size: usize = 2;
    @limits([Iterations(16)]) for value in values {
        let encoded = match quoted(value) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        size = size + len(encoded) + if fields.len() == 0 {
            0
        } else {
            1
        };
        if size > edit_json_bytes() {
            return Err("edit JSON output exceeds bound");
        }
        fields = fields.push(encoded);
    }
    return Ok("[" + join(fields, ",") + "]");
}

public flow object(keys: Array<string>, values: Array<string>) -> Result<string, string> {
    if keys.len() != values.len() || keys.len() > 16 {
        return Err("edit JSON key/value count invalid");
    }
    if unique(keys).len() != keys.len() {
        return Err("duplicate edit JSON key");
    }
    var fields: Array<string> = [];
    var size: usize = 2;
    var index: usize = 0;
    @limits([Iterations(16)]) while index < keys.len() {
        let key = match quoted(keys[index]) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        let value = match quoted(values[index]) {
            Ok(item) => item,
            Err(error) => {
                return Err(error);
            }
        };
        let field = key + ":" + value;
        size = size + len(field) + if fields.len() == 0 {
            0
        } else {
            1
        };
        if size > edit_json_bytes() {
            return Err("edit JSON output exceeds bound");
        }
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
    let json = match converted {
        Some(item) => item.body,
        None() => {
            return Err(conversion_error);
        }
    };
    return match stringify(json) {
        Ok(text) => Ok(text),
        Err(_) => Err(encoding_error)
    };
}

public enum FieldError {
    Json,
    Shape
}

// Framing and domain limits belong to each protocol; JSON unescaping is shared.
public flow decode_fields(raw: string) -> Result<Array<string>, FieldError> ![] {
    let value = match parse(raw) {
        Ok(item) => item,
        Err(_) => {
            return Err(FieldError.Json);
        }
    };
    let converted: Option<Message<Array<string>>> = Message.new(value).cast<Array<string>>();
    return match converted {
        Some(item) => Ok(item.body),
        None() => Err(FieldError.Shape)
    };
}

public flow string_fields(raw: string, json_error: string, shape_error: string) -> Result<
    Array<string>,
    string
> ![] {
    return match decode_fields(raw) {
        Ok(value) => Ok(value),
        Err(FieldError.Json) => Err(json_error),
        Err(FieldError.Shape) => Err(shape_error)
    };
}

// Already-encoded printable ASCII, including quote/backslash, stays unchanged.
public flow escaped(character: char) -> string {
    return scalar(character, false);
}

public flow ascii_json(json: string, maximum: usize, encoded_error: string, display_error: string) -> Result<
    string,
    string
> {
    return ascii_json_with(json, 131072, maximum, encoded_error, display_error);
}

// The standard JSON codec owns JSON framing and string escaping. This final
// terminal-safety pass only converts remaining non-ASCII scalars to JSON
// Unicode escapes; chunked std.text.concat avoids quadratic large-string growth.
public flow ascii_json_with(
    json: string,
    encoded_maximum: usize,
    maximum: usize,
    encoded_error: string,
    display_error: string
) -> Result<string, string> {
    if char_count(json) > encoded_maximum || len(json) > encoded_maximum {
        return Err(encoded_error);
    }
    // stringify() already escapes every ASCII control in its compact output,
    // so the standard constant-time ASCII query is the complete fast-path
    // check; rescanning every byte duplicated the codec and made MiB previews
    // interpreter-bound.
    if is_ascii(json) {
        if len(json) > maximum {
            return Err(display_error);
        }
        return Ok(json);
    }
    var output = TextBuilder.new();
    var size: usize = 0;
    // The largest caller accepts 16 Mi scalar inputs; keep its established
    // iteration envelope even when smaller callers select tighter byte bounds.
    @limits([Iterations(134217730)]) for codepoint in std.text.chars(json) {
        let fragment = escaped(codepoint);
        size = size + char_count(fragment);
        if size > maximum {
            return Err(display_error);
        }
        output.append(fragment);
    }
    return Ok(output.build());
}

public flow value<T>(input: T) -> JsonValue ![] {
    let converted: Option<Message<JsonValue>> = Message.new(input).cast<JsonValue>();
    return match converted {
        Some(value) => value.body,
        None() => abort("wire projection failed")
    };
}

public flow fields(input: JsonValue, updates: Array<(string, JsonValue)>) -> JsonValue ![] {
    var object: Map<string, JsonValue> = match input {
        JsonValue.Object(value) => value,
        _ => abort("wire projection requires an object")
    };
    for (name, value) in updates {
        object = object.insert(name, value);
    }
    return JsonValue.Object(object);
}
