module app.main;

import std.agent.message.Message;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.io.println;

flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let original = "\\n";
    let projected: Option<Message<JsonValue>> = Message.new(utf8_encode(original)).cast<JsonValue>();
    let value = match projected { Some(value) => value.body, None() => { abort("byte projection unavailable"); } };
    println(match stringify(value) { Ok(text) => text, Err(_) => { abort("byte encoding unavailable"); } });
    return 0;
}
