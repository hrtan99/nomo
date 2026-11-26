module nomo.application.harness.ports.agent_read_tool;

import nomo.domain.harness.tool_context.Context;

public spec ChildModel {
    flow infer(self, context: Context) -> string ![Error<IndexError>];
}
