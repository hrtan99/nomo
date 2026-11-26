module nomo.domain.harness.read_tool_contract;

import nomo.domain.context.large_context.context_bytes;
import std.json.JsonValue;
import std.agent.message.Message;
import nomo.domain.text.text.context_json_error;
import nomo.domain.harness.model_tool_contract.Session;
import nomo.domain.harness.harness_tool_contract.{Context, Observed, inspect_shared};

public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(message.cast<JsonValue>(), context_bytes(), true, "model context exceeds 33554432 serialized characters");
}

public flow inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, false, true);
}

public flow inspect_work(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_shared(child, status, request, task, allowed, true, true);
}
