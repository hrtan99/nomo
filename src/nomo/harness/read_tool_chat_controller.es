module nomo.harness.read_tool_chat_controller;

import nomo.harness.harness_tool_chat_contract.{Invocation, TurnResult};
import nomo.harness.shared_chat_controller.{run_shared_turn as shared_run, run_private_turn as shared_private};

public flow run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_run(request, allowed, invocation, true);
}

public flow run_private_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_private(request, allowed, invocation, true);
}
