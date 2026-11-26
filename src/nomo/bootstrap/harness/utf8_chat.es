module nomo.bootstrap.harness.utf8_chat;

import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.bootstrap.harness.chat.{run_shared_turn as shared_run, run_private_turn as shared_private};

public flow run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_run(request, allowed, invocation, true);
}

public flow run_private_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_private(request, allowed, invocation, true);
}
