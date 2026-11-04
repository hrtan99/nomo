module nomo.harness.read_tool_chat_contract;

import std.text.{len, starts_with};
import std.collections.len as count;
import std.json.JsonValue;
import std.agent.message.Message;
import nomo.core.conversation.Event;
import nomo.model.model_tool_contract.{Session, candidate_error};
import nomo.core.text.{printable, context_json_error};
import nomo.core.read_text.{bounded, safe};
import nomo.model.read_protocol.decode_child;
import nomo.harness.read_tool_contract.{Ledger, Observed, ledger_error};
import nomo.harness.read_tool_contract.fresh as fresh_ledger;

// Only validated successful selected data crosses a turn boundary.
public import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, Completed, LocalTurn, TurnResult, default_maximum, fresh_invocation, empty, seed, invocation_error, admission_error, combine};
import nomo.harness.harness_tool_chat_contract.{inspect_turn_shared, same};

public flow prior_error(prior: Previous) -> string {
    if prior.task == "" {
        if prior.result != "" || prior.tool != "" || prior.outcome != "" || prior.answer != "" {
            return "invalid empty prior selection";
        }
        return "";
    }
    if !bounded(prior.task, 512) || !bounded(prior.result, 256) || !bounded(prior.answer, 512) {
        return "invalid selected prior result";
    }
    if prior.tool == "" {
        if prior.outcome != "" { return "prior outcome without tool"; }
    } else if (prior.tool != "read" && prior.tool != "search") || !bounded(prior.outcome, 262154) || !(starts_with(prior.outcome, "complete: ") || (prior.tool == "search" && starts_with(prior.outcome, "incomplete: "))) {
        return "invalid selected prior tool";
    }
    return "";
}

public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    return context_json_error(message.cast<JsonValue>(), 1048576, true, "model context exceeds 1048576 serialized bytes");
}

// Check every prior event before projecting the unchanged one-shot validator's
// canonical local history. Projection is validation only; model inputs retain it.
public flow inspect_turn(child: Session, status: i32, request: string, task: string, allowed: Array<string>, prior: Previous) -> Result<Observed, string> {
    let invalid = prior_error(prior); if invalid != "" { return Err(invalid); }
    return inspect_turn_shared(child, status, request, task, allowed, prior, true);
}

public flow turn_error(invocation: Invocation) -> string {
    let invalid = admission_error(invocation.usage, invocation.maximum); if invalid != "" { return invalid; }
    let selected = prior_error(invocation.prior); if selected != "" { return selected; }
    let used = invocation.usage;
    if invocation.admitted == 0 {
        if invocation.prior.task != "" || used.steps != 0 || used.calls != 0 || used.tokens != 0 || used.tools != 0 || used.scan != 0 {
            return "first turn must own an empty invocation";
        }
    } else if invocation.admitted == 1 {
        let tools = if invocation.prior.tool == "" { 0 } else { 1 };
        if invocation.prior.task == "" || used.steps != 5 + tools * 2 || used.calls != 3 + tools ||
            used.tokens != (3 + tools) * 2048 || used.tools != tools || (used.scan != tools * 4096 && used.scan != tools * 16384) {
            return "prior selection and invocation ledger disagree";
        }
    } else { return "turn limit reached"; }
    return "";
}

// The opt-in four-turn budget is separate from the legacy two-turn contract.
// Amounts are reservations in application accounting, not measured usage.
public flow extended_maximum() -> Ledger {
    return Ledger { steps = 28, calls = 16, tokens = 32768, tools = 4, scan = 65536 };
}
public flow extended_invocation() -> Invocation {
    return Invocation { usage = fresh_ledger(), maximum = extended_maximum(), admitted = 0, prior = empty() };
}
public flow is_extended(maximum: Ledger) -> bool { return maximum == extended_maximum(); }

flow extended_ledger_error(value: Ledger) -> string {
    if value.steps < 0 || value.steps > 28 || value.calls < 0 || value.calls > 16 || value.tokens < 0 || value.tokens > 32768 ||
        value.tools < 0 || value.tools > 4 || value.scan < 0 || value.scan > 65536 { return "invalid extended invocation ledger"; }
    if value.steps < value.calls + value.tools || value.steps > value.calls + value.tools + 8 ||
        value.tokens != value.calls * 2048 || (value.scan < value.tools * 4096 || value.scan > value.tools * 16384 || value.scan % 4096 != 0) { return "invalid extended invocation ledger"; }
    return "";
}
public flow extended_admission_error(value: Ledger) -> string {
    let invalid = extended_ledger_error(value); if invalid != "" { return invalid; }
    if value.steps > 21 || value.calls > 12 || value.tokens > 24576 || value.tools > 3 || value.scan > 49152 {
        return "invocation worst-case turn reservation exhausted";
    }
    return "";
}
public flow extended_turn_error(invocation: Invocation) -> string {
    if !is_extended(invocation.maximum) { return "invalid extended invocation limits"; }
    let capacity = extended_admission_error(invocation.usage); if capacity != "" { return capacity; }
    let invalid = prior_error(invocation.prior); if invalid != "" { return invalid; }
    let turns = invocation.admitted; let used = invocation.usage;
    if turns < 0 || turns > 3 { return "turn limit reached"; }
    if turns == 0 {
        if invocation.prior.task != "" || used.steps != 0 || used.calls != 0 || used.tokens != 0 || used.tools != 0 || used.scan != 0 {
            return "first turn must own an empty invocation";
        }
    } else {
        let last_tool = if invocation.prior.tool == "" { 0 } else { 1 };
        if invocation.prior.task == "" || used.tools < last_tool || used.tools - last_tool > turns - 1 ||
            used.steps != turns * 5 + used.tools * 2 || used.calls != turns * 3 + used.tools ||
            used.tokens != used.calls * 2048 || (used.scan < used.tools * 4096 || used.scan > used.tools * 16384 || used.scan % 4096 != 0) {
            return "prior selection and invocation ledger disagree";
        }
    }
    return "";
}
public flow extended_combine(previous: Ledger, local: Ledger) -> Result<Ledger, string> {
    let invalid = extended_admission_error(previous); if invalid != "" { return Err(invalid); }
    let bad_local = ledger_error(local); if bad_local != "" { return Err(bad_local); }
    let value = Ledger { steps = previous.steps + local.steps, calls = previous.calls + local.calls,
        tokens = previous.tokens + local.tokens, tools = previous.tools + local.tools, scan = previous.scan + local.scan };
    let bad_total = extended_ledger_error(value); if bad_total != "" { return Err(bad_total); }
    return Ok(value);
}

// Persistent event sessions reserve a bounded series of turns without
// resetting any already charged usage.
public flow session_maximum() -> Ledger { return Ledger { steps = 224, calls = 128, tokens = 262144, tools = 32, scan = 524288 }; }
public flow session_invocation() -> Invocation { return Invocation { usage = fresh_ledger(), maximum = session_maximum(), admitted = 0, prior = empty() }; }
public flow session_turn_error(value: Invocation) -> string {
    if value.maximum != session_maximum() || value.admitted < 0 || value.admitted > 31 { return "session turn limit reached"; }
    let used = value.usage; let turns = value.admitted;
    if used.tools < 0 || used.tools > turns || used.steps != turns * 5 + used.tools * 2 ||
        used.calls != turns * 3 + used.tools || used.tokens != used.calls * 2048 || (used.scan < used.tools * 4096 || used.scan > used.tools * 16384 || used.scan % 4096 != 0) { return "invalid session ledger"; }
    let problem = prior_error(value.prior); if problem != "" { return problem; }
    if (turns == 0 && value.prior.task != "") || (turns > 0 && value.prior.task == "") { return "invalid session prior"; }
    let last_tool = if value.prior.tool == "" { 0 } else { 1 };
    if turns > 0 && (used.tools < last_tool || used.tools - last_tool > turns - 1) { return "invalid session prior tool"; }
    return "";
}
public flow session_combine(previous: Ledger, local: Ledger) -> Result<Ledger, string> {
    let error = ledger_error(local); if error != "" { return Err(error); }
    let value = Ledger { steps = previous.steps + local.steps, calls = previous.calls + local.calls,
        tokens = previous.tokens + local.tokens, tools = previous.tools + local.tools, scan = previous.scan + local.scan };
    if value.steps > 224 || value.calls > 128 || value.tokens > 262144 || value.tools > 32 || value.scan > 524288 { return Err("session allowance exhausted"); }
    return Ok(value);
}

// Check every seed and completed tool action before admitting a multi-step result.
public flow inspect_multi_turn(child: Session, status: i32, request: string, task: string, allowed: Array<string>, prior: Previous) -> Result<Observed, string> {
    if prior_error(prior) != "" || candidate_error(allowed) != "" || !bounded(request, 512) || !bounded(task, 512) { return Err("invalid child context"); }
    let tool_failure = status == 3 && child.tools > 0 && child.calls == child.tools;
    if (status != 0 && status != 3) || child.history.stopped || child.tools > 3 || (!tool_failure && child.calls != child.tools + 1) || child.tokens != child.calls * 4096 || child.scan != child.tools * 4194560 { return Err("invalid multi-step child ledger"); }
    let steps: i32 = if child.tools == 3 { 7 } else { if child.tools == 2 { 5 } else { if child.tools == 1 { 3 } else { 1 } } };
    if child.history.spent != steps - if tool_failure { 1 } else { 0 } { return Err("invalid multi-step child steps"); }
    let expected = seed(request, prior); let start = count(expected.events); let events = child.history.events;
    if count(events) != start + 1 + child.tools * 3 + if tool_failure { 0 } else { 2 } { return Err("invalid multi-step event count"); }
    var index: usize = 0; var characters: usize = 0;
    for event in events limit Iterations(18) {
        if len(event.name) > 8 || len(event.text) > 262154 || !printable(event.name) || !safe(event.text, 262154) { return Err("invalid multi-step event"); }
        if index < start && !same(event, expected.events[index]) { return Err("selected prior history changed"); }
        characters = characters + len(event.name) + len(event.text); index = index + 1;
    }
    if characters != child.history.characters || !same(events[start], Event { role = "user", kind = "input", name = "", text = task }) { return Err("invalid multi-step history"); }
    var cursor = start + 1; var tool = ""; var outcome = "";
    var i: usize = 0;
    while i < child.tools limit Iterations(3) {
        if !same(events[cursor], Event { role = "model", kind = "text", name = "qwen", text = "" }) { return Err("invalid multi-step model event"); }
        let request_event = events[cursor + 1]; let action = match decode_child(request_event.text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
        let result = events[cursor + 2];
        if tool_failure && i + 1 == child.tools {
            if request_event.role != "model" || request_event.kind != "request" || request_event.name != action.operation || (action.operation != "read" && action.operation != "search") || result.role != "tool" || result.kind != "error" || result.name != action.operation || !bounded(result.text, 262154) { return Err("invalid failed tool outcome"); }
            return Ok(Observed { result = "", tool = "", outcome = "" });
        }
        if request_event.role != "model" || request_event.kind != "request" || request_event.name != action.operation ||
            (action.operation != "read" && action.operation != "search") || result.role != "tool" || result.kind != "complete" || result.name != action.operation || !(starts_with(result.text, "complete: ") || (action.operation == "search" && starts_with(result.text, "incomplete: "))) { return Err("invalid multi-step tool outcome"); }
        tool = action.operation; outcome = result.text; cursor = cursor + 3; i = i + 1;
    }
    if !same(events[cursor], Event { role = "model", kind = "text", name = "qwen", text = "" }) { return Err("invalid final model event"); }
    let final = events[cursor + 1];
    if status == 3 { if final.role != "error" || final.kind != "error" || final.name != "" || !bounded(final.text, 512) { return Err("invalid multi-step refusal"); } return Ok(Observed { result = "", tool = "", outcome = "" }); }
    if final.role != "assistant" || final.kind != "final" || final.name != "" || !bounded(final.text, 256) { return Err("invalid multi-step final"); }
    return Ok(Observed { result = final.text, tool = tool, outcome = outcome });
}

// Separate reservations preserve the meaning of existing session records.
public flow multi_maximum(turns: i32) -> Ledger {
    return Ledger { steps = turns * 11, calls = turns * 6, tokens = turns * 20480, tools = turns * 3, scan = turns * 12583680 };
}
// A new reservation covers two 4096-token parent calls; legacy records retain their allowance.
public flow multi_wide_maximum(turns: i32) -> Ledger {
    return Ledger { steps = turns * 11, calls = turns * 6, tokens = turns * 24576, tools = turns * 3, scan = turns * 12583680 };
}
public flow multi_error(value: Ledger) -> string {
    if value.steps < 0 || value.steps > 11 || value.calls < 0 || value.calls > 6 || value.tools < 0 || value.tools > 3 ||
        (value.tokens < value.calls * 2048 || value.tokens > value.calls * 4096 || value.tokens % 2048 != 0) || value.scan != value.tools * 4194560 || value.steps < value.calls + value.tools || value.steps > value.calls + value.tools + 2 { return "invalid multi-step ledger"; }
    return "";
}
public flow multi_bump(value: Ledger, call: bool, wide: bool) -> Result<Ledger, string> {
    if multi_error(value) != "" { return Err("invalid multi-step ledger"); }
    let next = Ledger { steps = value.steps + 1, calls = value.calls + if call { 1 } else { 0 }, tokens = value.tokens + if call { if wide { 4096 } else { 2048 } } else { 0 }, tools = value.tools, scan = value.scan };
    let error = multi_error(next); if error != "" { return Err(error); } return Ok(next);
}
public flow multi_settle(value: Ledger, child: Session, wide: bool) -> Result<Ledger, string> {
    let expected = Ledger { steps = 2, calls = 1, tokens = if wide { 4096 } else { 2048 }, tools = 0, scan = 0 };
    if value != expected { return Err("child reservation not owned"); }
    if child.tools > 3 || (child.calls != child.tools && child.calls != child.tools + 1) || child.calls == 0 || child.tokens != child.calls * 4096 || child.scan != child.tools * 4194560 { return Err("invalid multi-step child ledger"); }
    let tools: i32 = if child.tools == 3 { 3 } else { if child.tools == 2 { 2 } else { if child.tools == 1 { 1 } else { 0 } } };
    let calls = tools + if child.calls == child.tools { 0 } else { 1 };
    if child.history.spent != calls + tools { return Err("invalid multi-step child steps"); }
    return Ok(Ledger { steps = 2 + calls + tools, calls = 1 + calls, tokens = (if wide { 4096 } else { 2048 }) + calls * 4096, tools = tools, scan = tools * 4194560 });
}
public flow multi_turn_error(value: Invocation, maximum: i32) -> string {
    let legacy = Ledger { steps = maximum * 11, calls = maximum * 6, tokens = maximum * 12288, tools = maximum * 3, scan = maximum * 49152 };
    let previous = Ledger { steps = maximum * 11, calls = maximum * 6, tokens = maximum * 12288, tools = maximum * 3, scan = maximum * 12583680 };
    if (value.maximum != multi_wide_maximum(maximum) && value.maximum != multi_maximum(maximum) && value.maximum != legacy && value.maximum != previous) || value.admitted < 0 || value.admitted > maximum { return "multi-step session turn limit reached"; }
    let used = value.usage; let turns = value.admitted; let scan_step = if value.maximum == legacy { 4096 } else { 256 };
    if used.tools < 0 || used.tools > turns * 3 || used.steps != turns * 5 + used.tools * 2 || used.calls != turns * 3 + used.tools ||
        used.tokens < used.calls * 2048 || used.tokens > turns * (if value.maximum == multi_wide_maximum(maximum) { 12288 } else { 8192 }) + used.tools * 4096 || used.tokens % 2048 != 0 ||
        (value.maximum == multi_wide_maximum(maximum) && used.tokens != turns * 12288 + used.tools * 4096) ||
        (value.maximum != multi_maximum(maximum) && value.maximum != multi_wide_maximum(maximum) && used.tokens != used.calls * 2048) || used.scan < used.tools * 4096 || used.scan > used.tools * if value.maximum == legacy { 16384 } else { 4194560 } || used.scan % scan_step != 0 { return "invalid multi-step session ledger"; }
    if prior_error(value.prior) != "" || (turns == 0 && value.prior.task != "") || (turns > 0 && value.prior.task == "") { return "invalid multi-step prior"; }
    let last_tool = if value.prior.tool == "" { 0 } else { 1 };
    let prior_limit = (turns - 1) * 3 + if last_tool == 1 { 2 } else { 0 };
    if turns > 0 && (used.tools < last_tool || used.tools - last_tool > prior_limit) { return "invalid multi-step prior tool"; }
    return "";
}
public flow multi_combine(previous: Ledger, local: Ledger, maximum: Ledger) -> Result<Ledger, string> {
    let error = multi_error(local); if error != "" { return Err(error); }
    let value = Ledger { steps = previous.steps + local.steps, calls = previous.calls + local.calls, tokens = previous.tokens + local.tokens, tools = previous.tools + local.tools, scan = previous.scan + local.scan };
    if value.steps > maximum.steps || value.calls > maximum.calls || value.tokens > maximum.tokens || value.tools > maximum.tools || value.scan > maximum.scan { return Err("multi-step session allowance exhausted"); }
    return Ok(value);
}
