module nomo.core.json;

import std.agent.message.Message;
import std.json.{JsonValue, parse, stringify};

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
