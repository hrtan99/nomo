module nomo.session.chat_session_contract;

import nomo.harness.harness_tool_chat_contract.{Invocation, TurnResult, Previous, fresh_invocation};
import nomo.harness.read_tool_chat_contract.{prior_error, turn_error};
import nomo.model.read_protocol.question_error;

// Persistent conversation data never carries filesystem authority or consent.
// An in-flight reservation remains unresolved after a restart; it cannot retry.
public type Session = { format: i32, phase: string, invocation: Invocation, last_request: string, pending: string };

public flow fresh() -> Session {
    return Session { format = 3, phase = "ready", invocation = fresh_invocation(), last_request = "", pending = "" };
}

public flow invalid(value: Session) -> string {
    if (value.format != 1 && value.format != 2 && value.format != 3) || (value.phase != "ready" && value.phase != "running" && value.phase != "complete") {
        return "invalid chat session format or phase";
    }
    let state = value.invocation; let used = state.usage; let standard = fresh_invocation();
    if state.maximum != standard.maximum || state.admitted < 0 || state.admitted > 2 { return "invalid chat session limits"; }
    if state.admitted == 0 {
        if state != standard || value.last_request != "" { return "invalid initial chat session"; }
    } else {
        if question_error(value.last_request) != "" || prior_error(state.prior) != "" || state.prior.task == "" {
            return "invalid chat session prior data";
        }
        let last_tool = if state.prior.tool == "" { 0 } else { 1 };
        if used.tools < last_tool || used.tools > state.admitted || used.tools - last_tool > state.admitted - 1 ||
            used.steps != state.admitted * 5 + used.tools * 2 || used.calls != state.admitted * 3 + used.tools ||
            used.tokens != used.calls * 2048 || used.scan != used.tools * 4096 { return "invalid chat session ledger"; }
    }
    if state.admitted == 2 {
        if value.phase != "complete" || value.pending != "" { return "finished session cannot run another turn"; }
    } else {
        if value.phase == "complete" { return "unfinished session cannot be complete"; }
        let turn = turn_error(state); if turn != "" { return turn; }
        if value.phase == "running" {
            if question_error(value.pending) != "" { return "invalid pending request"; }
        } else if value.pending != "" { return "ready session has pending request"; }
    }
    return "";
}

public flow begin(value: Session, request: string) -> Result<Session, string> {
    let error = invalid(value); if error != "" { return Err(error); }
    if value.phase != "ready" { return Err("chat session is not ready; no automatic retry"); }
    if question_error(request) != "" { return Err("invalid pending request"); }
    let next = Session { format = value.format, phase = "running", invocation = value.invocation, last_request = value.last_request, pending = request };
    let problem = invalid(next); if problem != "" { return Err(problem); }
    return Ok(next);
}

public flow complete(value: Session, result: TurnResult) -> Result<Session, string> {
    let error = invalid(value); if error != "" { return Err(error); }
    if value.phase != "running" { return Err("chat session has no running reservation"); }
    if result.status != 0 || !result.resolved { return Err("chat turn not confirmed; reservation remains unresolved"); }
    let done = match result.completed { Some(item) => item, None() => { return Err("completed chat turn missing"); } };
    let previous = value.invocation; let next = result.state; let selected = next.prior;
    if done.request != value.pending || done.task != selected.task || done.result != selected.result ||
        done.tool != selected.tool || done.outcome != selected.outcome || done.answer != selected.answer {
        return Err("completed chat projection changed");
    }
    let tools = if selected.tool == "" { 0 } else { 1 };
    if next.maximum != previous.maximum || next.admitted != previous.admitted + 1 ||
        next.usage.steps != previous.usage.steps + 5 + tools * 2 || next.usage.calls != previous.usage.calls + 3 + tools ||
        next.usage.tokens != previous.usage.tokens + (3 + tools) * 2048 || next.usage.tools != previous.usage.tools + tools ||
        next.usage.scan != previous.usage.scan + tools * 4096 { return Err("completed chat ledger changed"); }
    let session = Session { format = value.format, phase = if next.admitted == 2 { "complete" } else { "ready" },
        invocation = next, last_request = value.pending, pending = "" };
    let problem = invalid(session); if problem != "" { return Err(problem); }
    return Ok(session);
}
