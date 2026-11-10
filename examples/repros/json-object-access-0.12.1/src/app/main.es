module app.main;

import std.json.{JsonValue, parse};
import std.agent.message.Message;
import std.io.println;
import std.text.from_i64;

type Closed = { present: i64 };

flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let value = match parse("{\"present\":7}") { Ok(value) => value, Err(_) => { abort("synthetic JSON parse failed"); } };
    let record: Option<Message<Closed>> = Message.new(value).cast<Closed>();
    match record { Some(value) => { println("CLOSED_RECORD " + from_i64(value.body.present)); } None() => { abort("closed record projection failed"); } }
    let fields: Option<Message<Map<string, JsonValue>>> = Message.new(value).cast<Map<string, JsonValue>>();
    match fields {
        Some(_) => { println("JSON_OBJECT_MAP_AVAILABLE"); }
        None() => { println("JSON_OBJECT_MAP_UNAVAILABLE"); }
    }
    return 0;
}
