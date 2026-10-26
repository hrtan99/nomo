module nomo.session.bundle_codec;

import std.collections.len as count;
import std.text.{len, split};
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.core.text.printable;

public type Bundle = { format: i32, session_id: string, save_id: string, bodies: Array<string> };

// One array root plus at most 35 string leaves. No recursive decoder or generic
// object projection: field positions are marker, session ID, save ID, then bodies.
// Check encoded bytes and shape before allocating a parsed JSON tree/cast result.
flow framed(json: string) -> bool {
    if len(json) > 65536 || byte_count(utf8_encode(json)) > 65536 { return false; }
    var opened = false;
    var closed = false;
    var quoted = false;
    var escaped = false;
    var leaves: usize = 0;
    let slash = split("\\/", "")[1];
    for character in split(json, "") limit Iterations(65538) {
        if quoted {
            if escaped { escaped = false; }
            else if character == slash { escaped = true; }
            else if character == "\"" { quoted = false; }
        } else if character == "" || character == " " || character == "\n" || character == "\r" || character == "\t" {
        } else if character == "[" {
            if opened || closed { return false; }
            opened = true;
        } else if character == "]" {
            if !opened || closed { return false; }
            closed = true;
        } else if character == "\"" {
            if !opened || closed { return false; }
            leaves = leaves + 1;
            if leaves > 35 { return false; }
            quoted = true;
        } else if character != "," || !opened || closed { return false; }
    }
    return opened && closed && !quoted;
}

flow bundle_error(bundle: Bundle) -> string {
    if bundle.format != 1 { return "unsupported bundle format"; }
    if len(bundle.session_id) == 0 || len(bundle.session_id) > 128 ||
        len(bundle.save_id) == 0 || len(bundle.save_id) > 128 { return "invalid bundle identity"; }
    if !printable(bundle.session_id) || !printable(bundle.save_id) { return "invalid bundle identity"; }
    if count(bundle.bodies) > 32 { return "bundle body count exceeds limit"; }
    var characters: usize = 0;
    for body in bundle.bodies limit Iterations(32) {
        if len(body) > 8192 { return "bundle aggregate text exceeds limit"; }
        characters = characters + len(body);
        if characters > 8192 { return "bundle aggregate text exceeds limit"; }
    }
    return "";
}

public flow encode(bundle: Bundle) -> Result<string, string> {
    let error = bundle_error(bundle);
    if error != "" { return Err(error); }
    var fields = ["nomo-session-bundle-v1", bundle.session_id, bundle.save_id];
    for body in bundle.bodies limit Iterations(32) { fields = fields.push(body); }
    // Public checked Message.cast performs typed HostValue/JsonValue conversion;
    // these helpers issue no Host request and never attach a Session configuration.
    let message = Message.new(fields);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    match converted {
        Some(converted) => {
            match stringify(converted.body) {
                Ok(json) => {
                    if !framed(json) { return Err("bundle encoded bounds exceeded"); }
                    return Ok(json);
                },
                Err(_) => { return Err("bundle JSON encoding failed"); }
            }
        },
        None => { return Err("bundle checked encoding failed"); }
    }
}

public flow decode(json: string) -> Result<Bundle, string> {
    if !framed(json) { return Err("bundle encoded shape or bounds invalid"); }
    let parsed = match parse(json) {
        Ok(value) => value,
        Err(_) => { return Err("bundle JSON invalid"); }
    };
    let message = Message.new(parsed);
    let converted: Option<Message<Array<string>>> = message.cast<Array<string>>();
    let fields = match converted {
        Some(converted) => converted.body,
        None => { return Err("bundle must contain only strings"); }
    };
    if count(fields) < 3 || count(fields) > 35 { return Err("bundle field count invalid"); }
    if fields[0] != "nomo-session-bundle-v1" { return Err("unsupported bundle format"); }
    var bodies: Array<string> = [];
    var index: usize = 3;
    while index < count(fields) limit Iterations(32) {
        bodies = bodies.push(fields[index]);
        index = index + 1;
    }
    let bundle = Bundle { format = 1, session_id = fields[1], save_id = fields[2], bodies = bodies };
    let error = bundle_error(bundle);
    if error != "" { return Err(error); }
    return Ok(bundle);
}
