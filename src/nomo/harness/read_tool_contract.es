module nomo.harness.read_tool_contract;

import std.json.JsonValue;
import std.agent.message.Message;
import nomo.core.text.context_json_error;
import nomo.model.model_tool_contract.Session;

public import nomo.harness.harness_tool_contract.{Context, Ledger, Observed, numbers, fresh, ledger_error, bump, settle};
import nomo.harness.harness_tool_contract.inspect_shared;
public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(message.cast<JsonValue>(), 1048576, true, "model context exceeds 1048576 serialized characters");
}

public flow inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, false, true);
}
public flow inspect_work(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, true, true);
}
