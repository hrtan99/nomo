module nomo.session.bundle_codec;

import std.collections.len as count;
import std.text.len;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.core.text.{printable, flat_string_frame};

public type Bundle = { format: i32, session_id: string, save_id: string, bodies: Array<string> };

// One array root plus at most 35 string leaves. No recursive decoder or generic
// object projection: field positions are marker, session ID, save ID, then bodies.
// Check encoded bytes and shape before allocating a parsed JSON tree/cast result.
flow framed(json: string) -> bool { return flat_string_frame(json, 35, false); }

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
