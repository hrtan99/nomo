module nomo.harness.read_tool_contract;

import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.model.model_tool_contract.Session;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;

public import nomo.harness.harness_tool_contract.{Context, Ledger, Observed, numbers, fresh, ledger_error, bump, settle};
import nomo.harness.harness_tool_contract.inspect_shared;
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if byte_count(utf8_encode(encoded)) > 262144 { return "model context exceeds 262144 serialized characters"; }
    return "";
}

public flow inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, false, true);
}
public flow inspect_work(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, true, true);
}
