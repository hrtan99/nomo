module nomo.harness.harness_tool_contract;

import std.text.{len, starts_with};
import std.text.to_string_i32;
import std.collections.len as count;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.core.text.printable;
import nomo.core.conversation.Event;
import nomo.model.model_tool_contract.{Session, allowed_error, decode_reply};
import nomo.harness.harness_model_contract.bounded;

public type Context = { phase: string, request: string, task: string, result: string, tool: string, outcome: string, allowed: Array<string> };
public type Ledger = { steps: i32, calls: i32, tokens: i32, tools: i32, scan: i32 };
public type Observed = { result: string, tool: string, outcome: string };
public flow numbers(state: Ledger) -> string {
    return "steps=" + to_string_i32(state.steps) + " calls=" + to_string_i32(state.calls) + " tokens=" + to_string_i32(state.tokens) +
        " tools=" + to_string_i32(state.tools) + " scan=" + to_string_i32(state.scan);
}

public flow fresh() -> Ledger { return Ledger { steps = 0, calls = 0, tokens = 0, tools = 0, scan = 0 }; }

public flow ledger_error(state: Ledger) -> string {
    if state.steps < 0 || state.steps > 7 || state.calls < 0 || state.calls > 4 || state.tokens < 0 ||
        state.tokens > 8192 || state.tools < 0 || state.tools > 1 || state.scan < 0 || state.scan > 4096 {
        return "invalid shared tool ledger";
    }
    if state.steps < state.calls + state.tools || state.steps > state.calls + state.tools + 2 ||
        state.tokens != state.calls * 2048 || state.scan != state.tools * 4096 { return "invalid shared tool ledger"; }
    return "";
}

public flow bump(state: Ledger, call: bool) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    if state.steps >= 7 || (call && state.calls >= 4) ||
        (!call && state.steps >= state.calls + state.tools + 2) { return Err("shared reservation exhausted"); }
    return Ok(Ledger { steps = state.steps + 1, calls = state.calls + if call { 1 } else { 0 },
        tokens = state.tokens + if call { 2048 } else { 0 }, tools = state.tools, scan = state.scan });
}

flow child_ledger_error(child: Session) -> string {
    if child.history.spent < 1 || child.history.spent > 3 || child.calls < 1 || child.calls > 2 ||
        child.tokens > 4096 || child.tools > 1 || child.scan > 4096 { return "invalid child ledger"; }
    let calls: i32 = if child.calls == 2 { 2 } else { 1 };
    let tools: i32 = if child.tools == 1 { 1 } else { 0 };
    if child.history.spent != calls + tools || child.tokens != child.calls * 2048 ||
        child.scan != child.tools * 4096 || (child.calls == 2 && child.tools != 1) { return "invalid child ledger"; }
    return "";
}

public flow settle(state: Ledger, child: Session) -> Result<Ledger, string> {
    let invalid = ledger_error(state); if invalid != "" { return Err(invalid); }
    let child_invalid = child_ledger_error(child); if child_invalid != "" { return Err(child_invalid); }
    if state.steps != 2 || state.calls != 1 || state.tokens != 2048 || state.tools != 0 || state.scan != 0 {
        return Err("child reservation is not owned by this parent stage");
    }
    let calls: i32 = if child.calls == 2 { 2 } else { 1 };
    let tools: i32 = if child.tools == 1 { 1 } else { 0 };
    return Ok(Ledger { steps = 2 + child.history.spent, calls = 1 + calls, tokens = (1 + calls) * 2048,
        tools = tools, scan = tools * 4096 });
}

public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if len(encoded) > 2048 { return "model context exceeds 2048 serialized characters"; }
    return "";
}

flow same(event: Event, role: string, kind: string, name: string, text: string) -> bool {
    return event.role == role && event.kind == kind && event.name == name && event.text == text;
}

// Only the six ordinary return shapes reachable from our fresh seeded loop are admitted.
// Host aborts never reach this function and cannot be represented as settled returns.
public flow inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    let invalid = child_ledger_error(child); if invalid != "" { return Err(invalid); }
    if !bounded(request, 128) || !bounded(task, 128) || allowed_error(allowed) != "" { return Err("invalid selected child context"); }
    let events = child.history.events;
    let size = count(events);
    if size < 4 || size > 7 || child.history.stopped || child.history.characters > 8192 { return Err("invalid child history"); }
    var characters: usize = 0;
    for event in events limit Iterations(7) {
        if len(event.name) > 8 || len(event.text) > 512 || !printable(event.name) || !printable(event.text) {
            return Err("invalid child event data");
        }
        characters = characters + len(event.name) + len(event.text);
    }
    if characters != child.history.characters || !same(events[0], "user", "context", "original", request) ||
        !same(events[1], "user", "input", "", task) || !same(events[2], "model", "text", "qwen", "") {
        return Err("child original request or task history changed");
    }
    var tool = ""; var outcome = "";
    if child.tools == 0 {
        if size != 4 || child.calls != 1 || (status != 0 && status != 3) { return Err("invalid direct child shape"); }
    } else {
        if size < 5 || events[3].role != "model" || events[3].kind != "request" { return Err("missing selected child tool request"); }
        let action = match decode_reply(events[3].text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
        if (action.operation != "read" && action.operation != "search") || events[3].name != action.operation ||
            events[4].role != "tool" || events[4].name != action.operation { return Err("child tool identity changed"); }
        if size == 5 {
            if child.calls != 1 || status != 3 || events[4].kind != "error" || !bounded(events[4].text, 512) {
                return Err("invalid failed tool shape");
            }
        } else {
            if events[4].kind != "complete" || !bounded(events[4].text, 266) || !starts_with(events[4].text, "complete: ") {
                return Err("invalid completed tool outcome");
            }
            if size == 6 {
                if child.calls != 1 || status != 4 { return Err("invalid child context-refusal shape"); }
            } else if child.calls != 2 || (status != 0 && status != 3) || !same(events[5], "model", "text", "qwen", "") {
                return Err("invalid second child call shape");
            }
            tool = action.operation; outcome = events[4].text;
        }
    }
    let last = events[size - 1];
    if status == 0 {
        if last.role != "assistant" || last.kind != "final" || last.name != "" || !bounded(last.text, 512) {
            return Err("invalid child final event");
        }
        return Ok(Observed { result = last.text, tool = tool, outcome = outcome });
    }
    if size != 5 && (last.role != "error" || last.kind != "error" || last.name != "" || !bounded(last.text, 512)) {
        return Err("invalid child refusal event");
    }
    return Ok(Observed { result = "", tool = "", outcome = "" });
}
