module app.main;

import std.io.{println, IOError};
import std.agent.message.Message;
import std.json.{JsonValue, stringify};

type Item = { text: string, count: i64 };

public flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let converted: Option<Message<JsonValue>> = Message.new(Item { text = "synthetic", count = 7 }).cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => abort("record conversion failed") };
    let text = match stringify(value) { Ok(text) => text, Err(_) => abort("JSON encoding failed") };
    println(text);
    return 0;
}
