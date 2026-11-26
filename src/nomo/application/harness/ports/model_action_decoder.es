module nomo.application.harness.ports.model_action_decoder;

import nomo.domain.harness.model_tool_contract.Action;

public spec ToolActionDecoder {
    flow decode(self, raw: string, allowed: Array<string>, final_only: bool) -> Result<Action, string> ![Error<IndexError>];
    flow record(self, raw: string) -> string ![Error<IndexError>];
    flow diagnostic(self, raw: string, error: string, final_only: bool) -> string ![];
}
