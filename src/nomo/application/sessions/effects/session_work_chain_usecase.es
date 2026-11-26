module nomo.application.sessions.effects.session_work_chain_usecase;

import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.work_chain_usecase.{TurnRequest, WorkOutcome, CapturedShow};

public effect TerminalWork { action execute(request: TurnRequest) -> WorkOutcome; }

public effect TerminalRead {
    action show(selected: Selector) -> Result<Option<CapturedShow>, string>;
    action latest(workspace: string, path: string) -> Result<string, string>;
}
