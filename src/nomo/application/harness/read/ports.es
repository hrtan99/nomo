module nomo.application.harness.read.ports;

import nomo.domain.harness.model_tool_contract.{Session, LoopTurn};
import nomo.domain.harness.harness_tool_contract.{Context, Observed};
import nomo.harness.harness_tool_contract.Ledger;

public type Report = { request: string, task: string, allowed: Array<string>, child: Session,
    status: i32, observed: Observed, answer: string, ledger: Ledger };
public type Failure = { state: Ledger, error: string, resolved: bool };

public spec ReadContextValidation {
    flow request_error(self, value: string) -> string ![Error<IndexError>];
    flow validate_context(self, value: Context) -> string ![Error<IndexError>];
    flow decode(self, value: string) -> Result<string, string> ![Error<IndexError>];
    flow rejection(self, raw: string, error: string) -> string ![Error<IndexError>];
    flow observe_child(self, child: LoopTurn, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> ![Error<IndexError>];
    flow result_error(self, value: string) -> string ![Error<IndexError>];
    flow answer_error(self, value: string) -> string ![Error<IndexError>];
}
public spec ReadContextBudget {
    flow reserve(self, value: Ledger, call: bool) -> Result<Ledger, string> ![];
    flow settle_child(self, value: Ledger, child: Session) -> Result<Ledger, string> ![];
    flow allowance(self) -> Ledger ![];
}
public spec ReadContextProgress {
    flow progress(self, phase: string, state: Ledger, prefix: string) -> Array<string> ![];
}
