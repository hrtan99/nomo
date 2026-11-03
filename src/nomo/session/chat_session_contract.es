module nomo.session.chat_session_contract;

import nomo.harness.harness_tool_chat_contract.{Invocation, TurnResult, Previous, fresh_invocation};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.harness.read_tool_chat_contract.{prior_error, turn_error, session_maximum, session_invocation, session_turn_error, multi_maximum, multi_wide_maximum, multi_turn_error};
import nomo.model.read_protocol.question_error;

// Persistent conversation data never carries filesystem authority or consent.
// An in-flight reservation remains unresolved after a restart; it cannot retry.
public type Session = { format: i32, phase: string, invocation: Invocation, last_request: string, pending: string };

public flow fresh() -> Session {
    return Session { format = 12, phase = "ready", invocation = Invocation { usage = fresh_invocation().usage, maximum = multi_wide_maximum(2), admitted = 0, prior = fresh_invocation().prior }, last_request = "", pending = "" };
}
public flow fresh_events() -> Session {
    return Session { format = 13, phase = "ready", invocation = Invocation { usage = session_invocation().usage, maximum = multi_wide_maximum(32), admitted = 0, prior = session_invocation().prior }, last_request = "", pending = "" };
}

// Expand future per-turn scan reservations while preserving already recorded usage.
flow expanded(value: Invocation) -> Invocation {
    let old = value.maximum;
    let scan = if old.scan == 8192 { 32768 } else { if old.scan == 131072 { 524288 } else { old.scan } };
    let maximum = Ledger { steps = old.steps, calls = old.calls, tokens = old.tokens, tools = old.tools, scan = scan };
    return Invocation { usage = value.usage, maximum = maximum, admitted = value.admitted, prior = value.prior };
}

public flow invalid(value: Session) -> string {
    if (value.format < 1 || value.format > 13) || (value.phase != "ready" && value.phase != "running" && value.phase != "complete") { return "invalid chat session format or phase"; }
    let multi = value.format >= 5;
    let maximum = if value.format == 4 || value.format == 5 || value.format == 7 || value.format == 9 || value.format == 11 || value.format == 13 { 32 } else { 2 };
    let state = expanded(value.invocation); let used = state.usage;
    if state.admitted < 0 || state.admitted > maximum { return "invalid chat session limits"; }
    if value.format >= 11 && state.maximum != multi_wide_maximum(maximum) { return "invalid wide chat session limits"; }
    if value.format < 11 && state.maximum == multi_wide_maximum(maximum) { return "wide allowance requires new chat format"; }
    if multi {
        let error = multi_turn_error(state, maximum); if error != "" { return error; }
    } else {
        let standard = if value.format == 4 { session_invocation() } else { fresh_invocation() };
        if state.maximum != standard.maximum { return "invalid chat session limits"; }
        if state.admitted == 0 {
            if state != standard { return "invalid initial chat session"; }
        } else {
            let last_tool = if state.prior.tool == "" { 0 } else { 1 };
            if used.tools < last_tool || used.tools > state.admitted || used.tools - last_tool > state.admitted - 1 ||
                used.steps != state.admitted * 5 + used.tools * 2 || used.calls != state.admitted * 3 + used.tools ||
                used.tokens != used.calls * 2048 || (used.scan < used.tools * 4096 || used.scan > used.tools * 16384 || used.scan % 4096 != 0) { return "invalid chat session ledger"; }
        }
        if state.admitted < maximum {
            let turn = if value.format == 4 { session_turn_error(state) } else { turn_error(state) }; if turn != "" { return turn; }
        }
    }
    if state.admitted == 0 { if value.last_request != "" { return "invalid initial chat session"; } }
    else if question_error(value.last_request) != "" || prior_error(state.prior) != "" || state.prior.task == "" { return "invalid chat session prior data"; }
    if state.admitted == maximum {
        if value.phase != "complete" || value.pending != "" { return "finished session cannot run another turn"; }
    } else {
        if value.phase == "complete" { return "unfinished session cannot be complete"; }
        if value.phase == "running" { if question_error(value.pending) != "" { return "invalid pending request"; } }
        else if value.pending != "" { return "ready session has pending request"; }
    }
    return "";
}

// Upgrade only an already completed legacy event session; charge no new turn
// until begin() reserves it and retain the old cumulative usage and prior.
public flow extend(value: Session) -> Result<Session, string> {
    let error = invalid(value); if error != "" { return Err(error); }
    if value.format != 3 || value.phase != "complete" { return Err("completed event session required"); }
    let old = value.invocation;
    let invocation = Invocation { usage = old.usage, maximum = session_maximum(), admitted = old.admitted, prior = old.prior };
    let next = Session { format = 4, phase = "ready", invocation = invocation, last_request = value.last_request, pending = "" };
    let problem = invalid(next); if problem != "" { return Err(problem); } return Ok(next);
}

public flow begin(value: Session, request: string) -> Result<Session, string> {
    let error = invalid(value); if error != "" { return Err(error); }
    if value.phase != "ready" { return Err("chat session is not ready; no automatic retry"); }
    if question_error(request) != "" { return Err("invalid pending request"); }
    let old = expanded(value.invocation); let format = if value.format == 4 || value.format == 5 || value.format == 7 { 9 } else { if value.format == 3 || value.format == 6 || value.format == 8 { 10 } else { value.format } };
    let invocation = if format == 9 || format == 10 { Invocation { usage = old.usage, maximum = multi_maximum(if format == 9 { 32 } else { 2 }), admitted = old.admitted, prior = old.prior } } else { old };
    let next = Session { format = format, phase = "running", invocation = invocation, last_request = value.last_request, pending = request };
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
    let tools = next.usage.tools - previous.usage.tools;
    let maximum_tools = if value.format >= 5 { 3 } else { 1 };
    if tools < 0 || tools > maximum_tools || (selected.tool == "" && tools != 0) || (selected.tool != "" && tools == 0) ||
        next.maximum != previous.maximum || next.admitted != previous.admitted + 1 ||
        next.usage.steps != previous.usage.steps + 5 + tools * 2 || next.usage.calls != previous.usage.calls + 3 + tools ||
        next.usage.tokens != previous.usage.tokens + if value.format >= 11 { 12288 + tools * 4096 } else { if value.format >= 9 { 8192 + tools * 4096 } else { (3 + tools) * 2048 } } || next.usage.scan != previous.usage.scan + tools * if value.format >= 7 { 4194560 } else { 16384 } { return Err("completed chat ledger changed"); }
    let session = Session { format = value.format, phase = if next.admitted == (if value.format == 4 || value.format == 5 || value.format == 7 || value.format == 9 || value.format == 11 || value.format == 13 { 32 } else { 2 }) { "complete" } else { "ready" },
        invocation = next, last_request = value.pending, pending = "" };
    let problem = invalid(session); if problem != "" { return Err(problem); }
    return Ok(session);
}
