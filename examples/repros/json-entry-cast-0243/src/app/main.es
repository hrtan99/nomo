module app.main;

import std.io.{println, IOError};
import std.json.{JsonValue, parse};
import std.agent.message.Message;

type Entry = { key: string, value: JsonValue };

public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let value = match parse("[{\"key\":\"keep_messages\",\"value\":2}]") {
        Ok(value) => value,
        Err(_) => abort("valid synthetic JSON was rejected"),
    };
    println("parsed JSON");
    let converted: Option<Message<Array<Entry>>> = Message.new(value).cast<Array<Entry>>();
    let entries = match converted { Some(value) => value.body, None() => abort("entry conversion failed") };
    if entries.len() != 1 { abort("entry count changed"); }
    println("PASS parsed entry array");
    return 0;
}
