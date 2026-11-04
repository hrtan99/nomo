module nomo.agent.model_tool_controller;

import nomo.model.model_tool_contract.{Session, Limits};
import nomo.agent.read_tool_controller.run_legacy_loop;
public import nomo.agent.model_context.{history, failed, capacity, bounded_model_context};
public import nomo.model.model_tool_contract.LoopTurn;

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_legacy_loop(raw, allowed, limits, previous, work, inspect_all);
}
