module nomo.application.sessions.work_chain_usecase;

import nomo.domain.mutations.edit_contract.Selector;
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.harness.model_tool_contract.question_error;
import nomo.domain.harness.tool_context.allowed_error;
import nomo.domain.sessions.work_chain.policy_error;
import nomo.domain.harness.harness_work_contract.fresh;
import nomo.domain.sessions.work_chain_usecase.{WorkRequest, TurnRequest, WorkStop, WorkOutcome, CapturedShow};
import nomo.application.sessions.effects.session_work_chain_usecase.{TerminalWork, TerminalRead};

public flow work(request: TurnRequest) -> WorkRequest {
    return match request { TurnRequest.New(value) => value, TurnRequest.Continue(value) => value.work };
}

public flow selected_error(selected: Selector) -> string { return selector_error(selected.id, selected.workspace, selected.path); }

public flow latest_error(workspace: string, path: string) -> string { return selector_error("discovery", workspace, path); }

public flow request_error(request: TurnRequest) -> string {
    let value = work(request);
    let selected = selected_error(value.selected); if selected != "" { return selected; }
    let question = question_error(value.request); if question != "" { return question; }
    let allowed = allowed_error(value.allowed); if allowed != "" { return allowed; }
    let cap = policy_error(value.cap); if cap != "" { return cap; }
    match request {
        TurnRequest.Continue(next) => {
            let parent = selector_error(next.parent, value.selected.workspace, value.selected.path); if parent != "" { return parent; }
            if next.parent == value.selected.id { return "continuation requires a distinct child ID"; }
        }
        TurnRequest.New(_) => (),
    }
    return "";
}

public flow dispatch(request: TurnRequest) -> WorkOutcome ![TerminalWork.execute, Error<IndexError>, Error<BudgetExceeded>] {
    let invalid = request_error(request);
    if invalid != "" { return WorkOutcome.Stopped(WorkStop { state = fresh(), error = invalid }); }
    return perform TerminalWork.execute(request);
}

public flow read_selected(selected: Selector) -> Result<Option<CapturedShow>, string> ![TerminalRead.show, Error<IndexError>, Error<BudgetExceeded>] {
    let invalid = selected_error(selected); if invalid != "" { return Err(invalid); }
    return perform TerminalRead.show(selected);
}

public flow read_latest(workspace: string, path: string) -> Result<string, string> ![TerminalRead.latest, Error<IndexError>, Error<BudgetExceeded>] {
    let invalid = latest_error(workspace, path); if invalid != "" { return Err(invalid); }
    return perform TerminalRead.latest(workspace, path);
}
