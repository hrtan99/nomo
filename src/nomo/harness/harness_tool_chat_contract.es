module nomo.harness.harness_tool_chat_contract;

import std.text.{len, starts_with};
import std.collections.len as count;
import std.json.JsonValue;
import std.agent.message.Message;
import nomo.core.conversation.{Event, State, add, fresh};
import nomo.model.model_tool_contract.{Session, question_error, allowed_error, candidate_error};
import nomo.model.model_tool_contract.Context as ChildContext;
import nomo.model.model_tool_contract.context_error as child_context_error;
import nomo.core.text.{printable, context_json_error};
import nomo.core.read_text.{safe, bounded as utf8_bounded};
import nomo.model.read_protocol.question_error as utf8_question_error;
import nomo.harness.harness_model_contract.bounded;
import nomo.harness.harness_tool_contract.{Ledger, Observed, inspect, ledger_error, inspect_shared};
import nomo.harness.harness_tool_contract.fresh as fresh_ledger;

// Only validated successful selected data crosses a turn boundary.
public type Previous = { task: string, result: string, tool: string, outcome: string, answer: string };
public type Context = { phase: string, request: string, task: string, result: string, tool: string,
    outcome: string, allowed: Array<string>, prior: Previous };
public type Invocation = { usage: Ledger, maximum: Ledger, admitted: i32, prior: Previous };
public type Completed = { request: string, task: string, result: string, tool: string, outcome: string,
    answer: string, records: Array<Event> };
public type LocalTurn = { status: i32, usage: Ledger, selected: Previous, resolved: bool, completed: Option<Completed> };
public type TurnResult = { status: i32, state: Invocation, resolved: bool, completed: Option<Completed> };

public flow default_maximum() -> Ledger { return Ledger { steps = 14, calls = 8, tokens = 16384, tools = 2, scan = 32768 }; }
public flow fresh_invocation() -> Invocation {
    return Invocation { usage = fresh_ledger(), maximum = default_maximum(), admitted = 0, prior = empty() };
}

public flow empty() -> Previous {
    return Previous { task = "", result = "", tool = "", outcome = "", answer = "" };
}

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
    return context_json_error(message.cast<JsonValue>(), 2048, false, "model context exceeds 2048 serialized characters");
}

public flow seed(request: string, prior: Previous) -> State {
    var state = add(fresh(), Event { role = "user", kind = "context", name = "original", text = request });
    if prior.task != "" {
        state = add(state, Event { role = "user", kind = "context", name = "task", text = prior.task });
        state = add(state, Event { role = "user", kind = "context", name = "result", text = prior.result });
        state = add(state, Event { role = "user", kind = "context", name = "tool", text = prior.tool });
        state = add(state, Event { role = "user", kind = "context", name = "outcome", text = prior.outcome });
        state = add(state, Event { role = "user", kind = "context", name = "answer", text = prior.answer });
    }
    return state;
}

public flow same(left: Event, right: Event) -> bool {
    return left.role == right.role && left.kind == right.kind && left.name == right.name && left.text == right.text;
}

// Check every prior event before projecting the unchanged one-shot validator's
// canonical local history. Projection is validation only; model inputs retain it.
public flow inspect_turn_shared(child: Session, status: i32, request: string, task: string,
    allowed: Array<string>, prior: Previous, unicode: bool) -> Result<Observed, string> {
    let paths = if unicode { candidate_error(allowed) } else { allowed_error(allowed) }; if paths != "" { return Err(paths); }
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
        if len(event.name) > 8 || len(event.text) > (if unicode { 65546 } else { 512 }) || !printable(event.name) || !(if unicode { safe(event.text, 65546) } else { printable(event.text) }) {
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
            events[2].text != (if unicode { "model context exceeds 262144 serialized characters" } else { "model context exceeds 2048 serialized characters" }) {
            return Err("invalid unattempted child context refusal");
        }
        let context = ChildContext { history = input.events, allowed = allowed, final_only = false };
        if (if unicode { utf8_question_error(request) } else { question_error(request) }) != "" || !(if unicode { utf8_bounded(task, 512) } else { question_error(task) == "" }) ||
            child_context_error(context) != events[2].text {
            return Err("unproven child context refusal");
        }
        return Ok(Observed { result = "", tool = "", outcome = "" });
    }
    let state = State { events = normalized.events, characters = normalized.characters,
        spent = child.history.spent, stopped = child.history.stopped };
    return inspect_shared(Session { history = state, calls = child.calls, tokens = child.tokens,
        tools = child.tools, scan = child.scan }, status, request, task, allowed, unicode, unicode);
}

public flow inspect_turn(child: Session, status: i32, request: string, task: string, allowed: Array<string>, prior: Previous) -> Result<Observed, string> {
    let invalid = prior_error(prior); if invalid != "" { return Err(invalid); }
    return inspect_turn_shared(child, status, request, task, allowed, prior, false);
}

public flow invocation_error(state: Ledger) -> string {
    if state.steps < 0 || state.steps > 14 || state.calls < 0 || state.calls > 8 || state.tokens < 0 || state.tokens > 16384 ||
        state.tools < 0 || state.tools > 2 || state.scan < 0 || state.scan > 32768 { return "invalid invocation ledger"; }
    if state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 4 ||
        state.tokens != state.calls * 2048 || (state.scan < state.tools * 4096 || state.scan > state.tools * 16384 || state.scan % 4096 != 0) { return "invalid invocation ledger"; }
    return "";
}

public flow admission_error(state: Ledger, maximum: Ledger) -> string {
    let invalid = invocation_error(state); if invalid != "" { return invalid; }
    if maximum.steps < 0 || maximum.steps > 14 || maximum.calls < 0 || maximum.calls > 8 || maximum.tokens < 0 || maximum.tokens > 16384 ||
        maximum.tools < 0 || maximum.tools > 2 || maximum.scan < 0 || maximum.scan > 32768 { return "invalid invocation limits"; }
    if state.steps > maximum.steps - 7 || state.calls > maximum.calls - 4 || state.tokens > maximum.tokens - 8192 ||
        state.tools > maximum.tools - 1 || state.scan > maximum.scan - 16384 {
        return "invocation worst-case turn reservation exhausted";
    }
    return "";
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

public flow combine(state: Ledger, usage: Ledger, maximum: Ledger) -> Result<Ledger, string> {
    let invalid = admission_error(state, maximum); if invalid != "" { return Err(invalid); }
    let used = ledger_error(usage); if used != "" { return Err(used); }
    let result = Ledger { steps = state.steps + usage.steps, calls = state.calls + usage.calls, tokens = state.tokens + usage.tokens,
        tools = state.tools + usage.tools, scan = state.scan + usage.scan };
    let error = invocation_error(result); if error != "" { return Err(error); }
    return Ok(result);
}
