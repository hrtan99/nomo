module nomo.application.harness.ports.agent_child_loop_policy;

import nomo.domain.harness.model_tool_contract.Session;
import nomo.domain.harness.tool_context.Context;
import nomo.domain.harness.child_loop_policy.Shape;

public spec ChildLoopPolicy {
    flow shape(self) -> Shape ![];
    flow allowed_error(self, allowed: Array<string>) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow request_error(self, request: string) -> string ![Error<IndexError>, Error<BudgetExceeded>];
    flow validate_context(self, context: Context) -> string ![Error<IndexError>];
    flow reserve_model(self, state: Session, final_only: bool) -> Result<Session, string> ![Error<IndexError>];
    flow reserve_tool(self, state: Session) -> Result<Session, string> ![Error<IndexError>];
}
