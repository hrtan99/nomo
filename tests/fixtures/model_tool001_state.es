module nomo.model_tool_test;

import std.io.println;
import std.text.{split, len};
import std.collections.len as count;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.conversation.{State, Event, fresh, add, stop};
import nomo.model_tool_contract.{Action, Context, Session, Limits, fresh_loop, default_limits,
    decode_reply, allowed_error, question_error, context_error, budget_error, charge_action};
import nomo.model_tool.run_loop;
import nomo.path_policy.valid_path;

flow emit_action(value: Action) -> unit {
    let message = Message.new(value);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match converted { Some(item) => item.body, None() => { abort("test action conversion"); } };
    let encoded = match stringify(json) { Ok(item) => item, Err(_) => { abort("test action JSON"); } };
    println("OK " + encoded);
}

flow session(state: State, calls: usize, tokens: usize, tools: usize, scan: usize) -> Session {
    return Session { history = state, calls = calls, tokens = tokens, tools = tools, scan = scan };
}

flow limits(steps: i32, calls: usize, tokens: usize, scan: usize) -> Limits {
    return Limits { steps = steps, calls = calls, tokens = tokens, scan = scan };
}

flow pure_path(args: Array<string>) -> bool { return valid_path(args[0]); }

// No Model/File action is needed for the pure protocol and reservation cases.
flow probe(args: Array<string>) -> i32 {
    let mode = args[0];
    if mode == "decode" || mode == "final_only" {
        let allowed = if count(args) > 2 { split(args[2], ",") } else { ["a.txt", "b.txt"] };
        match decode_reply(args[1], allowed, mode == "final_only") {
            Ok(value) => { emit_action(value); } Err(error) => { println("ERR " + error); }
        }
        return 0;
    }
    if mode == "allowed" { println("RESULT " + allowed_error(split(args[1], ","))); return 0; }
    if mode == "question" { println("RESULT " + question_error(args[1])); return 0; }
    if mode == "context" {
        let context = Context { history = [Event { role = "tool", kind = "complete", name = "search", text = args[1] }],
            allowed = [args[2], args[3]], final_only = true };
        let message = Message.new(context);
        let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
        let json = match converted { Some(item) => item.body, None() => { abort("test context conversion"); } };
        let encoded = match stringify(json) { Ok(item) => item, Err(_) => { abort("test context JSON"); } };
        println("JSON " + encoded);
        println("RESULT " + context_error(context));
        return 0;
    }
    if mode == "ledgers" {
        let limits = default_limits();
        let first = fresh_loop();
        if budget_error(first, limits, false) != "" { abort("first model incorrectly refused"); }
        let model = charge_action(first, false);
        if model.history.spent != 1 || model.calls != 1 || model.tokens != 2048 || model.tools != 0 || model.scan != 0 {
            abort("model accounting");
        }
        if budget_error(model, limits, true) != "" { abort("first tool incorrectly refused"); }
        let tool = charge_action(model, true);
        if tool.history.spent != 2 || tool.calls != 1 || tool.tokens != 2048 || tool.tools != 1 || tool.scan != 4096 {
            abort("independent tool accounting");
        }
        if budget_error(tool, limits, false) != "" || budget_error(tool, limits, true) == "" { abort("post-tool admission"); }
        let final = charge_action(tool, false);
        if final.history.spent != 3 || final.calls != 2 || final.tokens != 4096 || final.tools != 1 || final.scan != 4096 {
            abort("final model accounting");
        }
        if budget_error(final, limits, false) == "" || budget_error(final, limits, true) == "" { abort("hard step cap"); }
        if first.history.spent != 0 || count(first.history.events) != 0 || first.calls != 0 { abort("pure state was mutated"); }
        println("LEDGERS_OK"); return 0;
    }
    if mode == "budgets" {
        let initial = fresh_loop();
        let defaults = default_limits();
        if budget_error(initial, limits(0, 2, 4096, 4096), false) == "" { abort("step zero"); }
        if budget_error(initial, limits(3, 0, 4096, 4096), false) == "" { abort("call zero"); }
        if budget_error(initial, limits(3, 2, 2047, 4096), false) == "" { abort("token below reservation"); }
        if budget_error(initial, limits(3, 2, 2048, 4096), false) != "" { abort("token exact reservation"); }
        if budget_error(initial, limits(3, 2, 4096, 4095), true) == "" { abort("scan below reservation"); }
        if budget_error(initial, defaults, true) != "" { abort("scan exact reservation"); }
        if budget_error(session(fresh(), 2, 4096, 0, 0), limits(16, 16, 65536, 65536), false) == "" { abort("hard model cap"); }
        if budget_error(session(fresh(), 0, 2049, 0, 0), defaults, false) == "" { abort("hard token cap independent"); }
        if budget_error(session(fresh(), 0, 0, 1, 4096), defaults, true) == "" { abort("hard tool cap independent"); }
        if budget_error(session(fresh(), 0, 0, 0, 1), defaults, true) == "" { abort("hard scan cap independent"); }
        if budget_error(session(stop(fresh()), 0, 0, 0, 0), defaults, false) == "" { abort("stopped state"); }
        if budget_error(session(fresh(), 0, 4097, 0, 0), defaults, true) == "" { abort("invalid ledger"); }
        let one = charge_action(initial, false);
        if budget_error(one, limits(3, 1, 4096, 4096), false) == "" { abort("caller call cap"); }
        if budget_error(one, limits(3, 2, 4095, 4096), false) == "" { abort("caller token cap"); }
        if budget_error(one, defaults, false) != "" { abort("exact second reservation"); }
        println("BUDGETS_OK"); return 0;
    }
    abort("unknown pure test case");
}

// Boundary failures before any adapter request. Outer real-Host tests exercise
// the later model/tool boundaries and capture actual HTTP/File counts.
flow boundary(args: Array<string>) -> i32 {
    let mode = args[0];
    var prior = fresh_loop();
    var limits = default_limits();
    if mode == "steps" { limits = Limits { steps = 0, calls = 2, tokens = 4096, scan = 4096 }; }
    else if mode == "calls" { prior = session(fresh(), 2, 4096, 0, 0); }
    else if mode == "tokens" { limits = Limits { steps = 3, calls = 2, tokens = 2047, scan = 4096 }; }
    else {
        var state = fresh();
        var events: usize = 31;
        if mode == "content" { events = 8; }
        if mode == "context" { events = 4; }
        if mode == "model-events" { events = 29; }
        var index: usize = 0;
        while index < events limit Iterations(31) {
            state = add(state, Event { role = "user", kind = "input", name = "", text = args[1] });
            index = index + 1;
        }
        prior = session(state, 0, 0, 0, 0);
    }
    let result = run_loop("hello", ["a.txt"], limits, prior);
    if result.status != 4 || result.state.history.spent != 0 || result.state.calls != prior.calls ||
        result.state.tokens != prior.tokens || result.state.tools != 0 || result.state.scan != 0 { abort("boundary charged denied action"); }
    if count(result.state.history.events) > 32 || result.state.history.characters > 8192 { abort("terminal reserve exceeded"); }
    if count(prior.history.events) > 0 && result.state.history.events[0] != prior.history.events[0] {
        abort("existing history changed");
    }
    println("BOUNDARY_OK"); return 0;
}
