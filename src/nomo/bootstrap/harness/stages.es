module nomo.bootstrap.harness.stages;

import nomo.domain.harness.harness_tool_chat_contract.TurnResult;
import nomo.harness.harness_tool_chat_contract.Invocation;
import nomo.application.harness.effects.harness_legacy_chat_stages.LegacyChatStages;
import nomo.bootstrap.harness.utf8_chat.{run_turn_controller, run_private_turn_controller};
import nomo.application.harness.ports.harness_chat_stages.ReadStages;

// The controller performs operations; the composition boundary installs one handler.
public flow run_public<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => { resume stages.main(context); }
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => { resume stages.child(task, files, selected, multi, resilient, high_input, reasoning); }
    };
}

public flow run_private<S ~ ReadStages>(stages: S, request: string, allowed: Array<string>, invocation: Invocation) -> TurnResult {
    return run_private_turn_controller(request, allowed, invocation) with {
        LegacyChatStages.main(context) => { resume stages.main(context); }
        LegacyChatStages.child(task, files, selected, multi, resilient, high_input, reasoning) => { resume stages.child(task, files, selected, multi, resilient, high_input, reasoning); }
    };
}
