module nomo.harness.read_tool_contract;

import std.text.{len, starts_with};
import std.text.to_string_i32;
import std.collections.len as count;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.core.text.printable;
import nomo.core.conversation.Event;
import nomo.model.model_tool_contract.{Session, candidate_error};
import nomo.core.read_text.{bounded, safe};
import nomo.model.read_protocol.decode_child;
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;

public import nomo.harness.harness_tool_contract.{Context, Ledger, Observed, numbers, fresh, ledger_error, bump, settle};
flow child_ledger_error(child: Session, work: bool) -> string {
    if child.history.spent < 1 || child.history.spent > 3 || child.calls < 1 || child.calls > 2 ||
        child.tokens > (if work { 8192 } else { 4096 }) || child.tools > 1 || child.scan > 16384 { return "invalid child ledger"; }
    let calls: i32 = if child.calls == 2 { 2 } else { 1 };
    let tools: i32 = if child.tools == 1 { 1 } else { 0 };
    if child.history.spent != calls + tools || (child.tokens != child.calls * 2048 && !(work && child.tokens == child.calls * 4096)) ||
        (child.scan != child.tools * 4096 && child.scan != child.tools * 16384) || (child.calls == 2 && child.tools != 1) { return "invalid child ledger"; }
    return "";
}

public flow context_error(context: Context) -> string {
    let message = Message.new(context);
    let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match conversion { Some(value) => value.body, None() => { return "context conversion refused"; } };
    let encoded = match stringify(json) { Ok(value) => value, Err(_) => { return "context JSON refused"; } };
    if byte_count(utf8_encode(encoded)) > 262144 { return "model context exceeds 262144 serialized characters"; }
    return "";
}

flow same(event: Event, role: string, kind: string, name: string, text: string) -> bool {
    return event.role == role && event.kind == kind && event.name == name && event.text == text;
}

// Only the six ordinary return shapes reachable from our fresh seeded loop are admitted.
// Host aborts never reach this function and cannot be represented as settled returns.
flow inspect_mode(child: Session, status: i32, request: string, task: string, allowed: Array<string>, work: bool) -> Result<Observed, string> {
    let invalid = child_ledger_error(child, work); if invalid != "" { return Err(invalid); }
    if !bounded(request, 128) || !bounded(task, if work { 512 } else { 128 }) || candidate_error(allowed) != "" { return Err("invalid selected child context"); }
    let events = child.history.events;
    let size = count(events);
    if size < 4 || size > 7 || child.history.stopped || child.history.characters > 262144 { return Err("invalid child history"); }
    var characters: usize = 0;
    for event in events limit Iterations(7) {
        if len(event.name) > 8 || len(event.text) > 65546 || !printable(event.name) || !safe(event.text, 65546) {
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
        let action = match decode_child(events[3].text, allowed, false) { Ok(value) => value, Err(error) => { return Err(error); } };
        if (action.operation != "read" && action.operation != "search") || events[3].name != action.operation ||
            events[4].role != "tool" || events[4].name != action.operation { return Err("child tool identity changed"); }
        if size == 5 {
            if child.calls != 1 || status != 3 || events[4].kind != "error" || !bounded(events[4].text, 512) {
                return Err("invalid failed tool shape");
            }
        } else {
            if events[4].kind != "complete" || !bounded(events[4].text, 65546) || !starts_with(events[4].text, "complete: ") {
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

public flow inspect(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_mode(child, status, request, task, allowed, false);
}
public flow inspect_work(child: Session, status: i32, request: string, task: string, allowed: Array<string>) -> Result<Observed, string> {
    return inspect_mode(child, status, request, task, allowed, true);
}
