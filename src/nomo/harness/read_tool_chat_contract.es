module nomo.harness.read_tool_chat_contract;

import std.text.{len, starts_with};
import std.collections.len as count;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.core.conversation.{Event, State, add, fresh};
import nomo.model.model_tool_contract.{Session, allowed_error};
import nomo.model.model_tool_contract.Context as ChildContext;
import nomo.model.model_tool_contract.context_error as child_context_error;
import nomo.core.text.printable;
import nomo.core.read_text.{bounded, safe};
import nomo.model.read_protocol.question_error;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.harness.read_tool_contract.{Ledger, Observed, inspect_work, ledger_error};
import nomo.harness.read_tool_contract.fresh as fresh_ledger;

// Only validated successful selected data crosses a turn boundary.
public import nomo.harness.harness_tool_chat_contract.{Previous, Context, Invocation, Completed, LocalTurn, TurnResult, default_maximum, fresh_invocation, empty, seed, invocation_error, admission_error, combine};

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
    } else if (prior.tool != "read" && prior.tool != "search") || !bounded(prior.outcome, 266) || !starts_with(prior.outcome, "complete: ") {
        return "invalid selected prior tool";
    }
    return "";
}

public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if byte_count(utf8_encode(encoded)) > 8192 { return "model context exceeds 8192 serialized bytes"; }
    return "";
}

flow same(left: Event, right: Event) -> bool {
    return left.role == right.role && left.kind == right.kind && left.name == right.name && left.text == right.text;
}

// Check every prior event before projecting the unchanged one-shot validator's
// canonical local history. Projection is validation only; model inputs retain it.
public flow inspect_turn(child: Session, status: i32, request: string, task: string,
    allowed: Array<string>, prior: Previous) -> Result<Observed, string> {
    let invalid = prior_error(prior); if invalid != "" { return Err(invalid); }
    let paths = allowed_error(allowed); if paths != "" { return Err(paths); }
    let expected = seed(request, prior);
    let size = count(expected.events);
    if count(child.history.events) < size + 2 || count(child.history.events) > size + 6 || child.history.stopped {
        return Err("invalid selected prior history");
    }
    var position: usize = 0;
    var normalized = fresh();
    var input = fresh();
    var characters: usize = 0;
    for event in child.history.events limit Iterations(12) {
        if len(event.name) > 8 || len(event.text) > 512 || !printable(event.name) || !safe(event.text, 512) {
            return Err("invalid selected history data");
        }
        characters = characters + len(event.name) + len(event.text);
        if position < size && !same(event, expected.events[position]) { return Err("selected prior history changed"); }
        if position == 0 || position >= size { normalized = add(normalized, event); }
        if position < size + 1 { input = add(input, event); }
        position = position + 1;
    }
    if characters != child.history.characters { return Err("invalid selected history character count"); }
    if child.calls == 0 {
        let events = normalized.events;
        let expected_input = Event { role = "user", kind = "input", name = "", text = task };
        if count(events) != 3 || status != 4 || child.history.spent != 0 || child.tokens != 0 || child.tools != 0 || child.scan != 0 ||
            !same(events[1], expected_input) ||
            events[2].role != "error" || events[2].kind != "error" || events[2].name != "" ||
            events[2].text != "model context exceeds 2048 serialized characters" {
            return Err("invalid unattempted child context refusal");
        }
        let context = ChildContext { history = input.events, allowed = allowed, final_only = false };
        if question_error(request) != "" || !bounded(task, 512) ||
            child_context_error(context) != events[2].text {
            return Err("unproven child context refusal");
        }
        return Ok(Observed { result = "", tool = "", outcome = "" });
    }
    let state = State { events = normalized.events, characters = normalized.characters,
        spent = child.history.spent, stopped = child.history.stopped };
    return inspect_work(Session { history = state, calls = child.calls, tokens = child.tokens,
        tools = child.tools, scan = child.scan }, status, request, task, allowed);
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
            used.tokens != (3 + tools) * 2048 || used.tools != tools || used.scan != tools * 4096 {
            return "prior selection and invocation ledger disagree";
        }
    } else { return "turn limit reached"; }
    return "";
}

// The opt-in four-turn budget is separate from the legacy two-turn contract.
// Amounts are reservations in application accounting, not measured usage.
public flow extended_maximum() -> Ledger {
    return Ledger { steps = 28, calls = 16, tokens = 32768, tools = 4, scan = 16384 };
}
public flow extended_invocation() -> Invocation {
    return Invocation { usage = fresh_ledger(), maximum = extended_maximum(), admitted = 0, prior = empty() };
}
public flow is_extended(maximum: Ledger) -> bool { return maximum == extended_maximum(); }

flow extended_ledger_error(value: Ledger) -> string {
    if value.steps < 0 || value.steps > 28 || value.calls < 0 || value.calls > 16 || value.tokens < 0 || value.tokens > 32768 ||
        value.tools < 0 || value.tools > 4 || value.scan < 0 || value.scan > 16384 { return "invalid extended invocation ledger"; }
    if value.steps < value.calls + value.tools || value.steps > value.calls + value.tools + 8 ||
        value.tokens != value.calls * 2048 || value.scan != value.tools * 4096 { return "invalid extended invocation ledger"; }
    return "";
}
public flow extended_admission_error(value: Ledger) -> string {
    let invalid = extended_ledger_error(value); if invalid != "" { return invalid; }
    if value.steps > 21 || value.calls > 12 || value.tokens > 24576 || value.tools > 3 || value.scan > 12288 {
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
            used.tokens != used.calls * 2048 || used.scan != used.tools * 4096 {
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
public flow session_maximum() -> Ledger { return Ledger { steps = 224, calls = 128, tokens = 262144, tools = 32, scan = 131072 }; }
public flow session_invocation() -> Invocation { return Invocation { usage = fresh_ledger(), maximum = session_maximum(), admitted = 0, prior = empty() }; }
public flow session_turn_error(value: Invocation) -> string {
    if value.maximum != session_maximum() || value.admitted < 0 || value.admitted > 31 { return "session turn limit reached"; }
    let used = value.usage; let turns = value.admitted;
    if used.tools < 0 || used.tools > turns || used.steps != turns * 5 + used.tools * 2 ||
        used.calls != turns * 3 + used.tools || used.tokens != used.calls * 2048 || used.scan != used.tools * 4096 { return "invalid session ledger"; }
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
    if value.steps > 224 || value.calls > 128 || value.tokens > 262144 || value.tools > 32 || value.scan > 131072 { return Err("session allowance exhausted"); }
    return Ok(value);
}
