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
import nomo.harness.read_tool_contract.{Ledger, Observed, inspect, ledger_error};
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
    if question_error(prior.task) != "" || !bounded(prior.result, 256) || !bounded(prior.answer, 512) {
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
    if byte_count(utf8_encode(encoded)) > 2048 { return "model context exceeds 2048 serialized characters"; }
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
        if question_error(request) != "" || question_error(task) != "" ||
            child_context_error(context) != events[2].text {
            return Err("unproven child context refusal");
        }
        return Ok(Observed { result = "", tool = "", outcome = "" });
    }
    let state = State { events = normalized.events, characters = normalized.characters,
        spent = child.history.spent, stopped = child.history.stopped };
    return inspect(Session { history = state, calls = child.calls, tokens = child.tokens,
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
