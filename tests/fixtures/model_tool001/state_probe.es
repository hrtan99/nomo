module nomo.model_tool_probe;

import nomo.conversation.{Event, State};
import nomo.model_tool_contract.{Session, Limits};
import nomo.model_tool.run_loop;
import std.agent.message.Message;
import std.json.{JsonValue, stringify};
import std.io.println;

// Test-only typed entry. The observer substitutes literal initial state/limits;
// all admission, charging, Model/File dispatch and output remain product code.
flow observe(args: Array<string>) -> i32 {
    let previous = __PREVIOUS__;
    let limits = __LIMITS__;
    let result = run_loop(args[0], __ALLOWED__, limits, previous);
    let message = Message.new(result);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let value = match converted { Some(item) => item.body, None() => abort("test result conversion") };
    let text = match stringify(value) { Ok(item) => item, Err(_) => abort("test result serialization") };
    println("PROBE " + text);
    return 0;
}
