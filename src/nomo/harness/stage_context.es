module nomo.harness.stage_context;

import std.agent.message.Message;
import std.json.JsonValue;
import nomo.harness.harness_edit_contract.history_bound;

// Preserve the concrete input and all evidence; only verify its encoded bound.
public flow bounded_history<T>(value: T, kind: string) -> T {
    let converted: Option<Message<JsonValue>> = Message.new(value).cast<JsonValue>();
    history_bound(converted, 8388608, kind);
    return value;
}
