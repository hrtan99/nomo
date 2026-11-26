module nomo.bootstrap.harness.legacy_model_tool;

import nomo.domain.harness.model_tool_contract.{Session, Limits, LoopTurn};
import nomo.bootstrap.harness.read.run_legacy_loop;

public flow run_loop_controller(raw: string, allowed: Array<string>, limits: Limits, previous: Session, work: bool, inspect_all: bool) -> LoopTurn {
    return run_legacy_loop(raw, allowed, limits, previous, work, inspect_all);
}
