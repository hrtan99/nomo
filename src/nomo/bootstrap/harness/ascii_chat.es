module nomo.bootstrap.harness.ascii_chat;

import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.bootstrap.harness.chat.run_shared_turn as shared_run;

public flow run_turn_controller(request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return shared_run(request, allowed, invocation, false);
}
