module nomo.application.harness.effects.harness_legacy_chat_stages;

import nomo.domain.harness.harness_tool_chat_contract.Context;
import nomo.core.conversation.State;
import nomo.domain.harness.model_tool_contract.LoopTurn;

public effect LegacyChatStages {
    action main(context: Context) -> string;
    action child(task: string, allowed: Array<string>, selected: State, multi: bool, resilient: bool, high_input: bool, reasoning: bool) -> LoopTurn;
}
