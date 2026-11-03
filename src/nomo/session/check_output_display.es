module nomo.session.check_output_display;

import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.text.{len, split};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.session.check_output.Record;
import nomo.session.session_display.escaped;

// JSON string escapes make line controls and invisible Unicode safe to print,
// and let a reader reconstruct the stored streams without guessing markers.
public flow render(value: Record) -> Result<string, string> {
    let converted: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    let json_value = match converted { Some(item) => item.body, None() => { return Err("check output conversion refused"); } };
    let json = match stringify(json_value) { Ok(item) => item, Err(_) => { return Err("check output encoding refused"); } };
    if len(json) > 131072 || byte_count(utf8_encode(json)) > 131072 { return Err("check output encoding exceeds bound"); }
    var output = ""; var size: usize = 0;
    for character in split(json, "") limit Iterations(131074) {
        let fragment = escaped(character); size = size + len(fragment);
        if size > 262144 { return Err("check output display exceeds bound"); }
        output = output + fragment;
    }
    return Ok(output);
}
