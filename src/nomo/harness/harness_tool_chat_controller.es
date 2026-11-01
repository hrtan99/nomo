module nomo.harness.harness_tool_chat_controller;

import nomo.harness.harness_tool_chat_contract.{Invocation, TurnResult};
import nomo.harness.shared_chat_controller.run_shared_turn as shared_run;

public flow run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_run(request, allowed, invocation, false);
}
