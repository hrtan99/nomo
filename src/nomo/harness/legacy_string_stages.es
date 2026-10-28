module nomo.harness.legacy_string_stages;

import nomo.harness.harness_tool_contract.Context;
import nomo.core.conversation.State;
import nomo.model.model_tool_contract.{LoopTurn, Context as ChildContext};
import nomo.harness.harness_work_contract.Context as EditContext;

// Legacy strings and inspected child returns; never a native typed-output bridge.
public effect LegacyStringStages {
    action main(context: Context) -> string;
    action child(task: string, allowed: Array<string>, selected: State) -> LoopTurn;
}

public effect LegacyChildModel {
    action infer(context: ChildContext) -> string;
}
public effect LegacyEditStages {
    action plan(context: EditContext) -> string;
    action child(context: EditContext) -> string;
    action aggregate(context: EditContext) -> string;
}
