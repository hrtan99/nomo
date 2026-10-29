module app.output_probe;

import std.io.println;
import std.text.split;
import nomo.core.conversation.{Event, State};
import nomo.agent.conversation_events.{Turn, emit, failure};
import nomo.agent.stub_loop_controller.turn_controller;
import nomo.agent.loop.turn as production_turn;
import nomo.agent.console_events.publish;
import nomo.model.conversation_output.ConversationOutput;
import nomo.tools.edit_encoding.json;

flow slash() -> string { return split("\\/", "")[1]; }
flow collect(event: Event) -> unit {
    let value = match json([event.role, event.kind, event.name, event.text]) {
        Ok(text) => text, Err(_) => abort("bounded collector encoding refused"),
    };
    println("COLLECT " + value);
}
flow collected(raw: string, maximum: i32, budget: i32, previous: State) -> Turn {
    return turn_controller(raw, maximum, budget, previous) with {
        ConversationOutput.publish(event) => { resume collect(event); }
    };
}
public flow semantic_emit(args: Array<string>) -> State {
    let previous = __SEMANTIC_PREVIOUS__;
    return emit(previous, "tool", "complete", "read", "é\n");
}
public flow semantic_controller(args: Array<string>) -> Turn {
    let previous = __EMPTY__;
    return turn_controller("tool:echo:blue", 3, 6, previous);
}
public flow console_sink(args: Array<string>) -> unit {
    let event = Event { role = "tool", kind = "complete", name = "read", text = "blue" };
    return publish(event);
}
public flow collector_observe(args: Array<string>) -> i32 {
    __COLLECTOR_CASES__
    return 0;
}
public flow production_observe(args: Array<string>) -> i32 {
    __PRODUCTION_CASES__
    return 0;
}
public flow semantic_observe(args: Array<string>) -> i32 {
    println("CASE unicode_append");
    let emitted = semantic_emit(args) with { ConversationOutput.publish(event) => { resume collect(event); } };
    let expected_emit = __SEMANTIC_EXPECTED__;
    if emitted != expected_emit { abort("whole semantic State differs"); }
    println("PASS unicode_append");
    println("CASE failure_status");
    let previous = __SEMANTIC_PREVIOUS__;
    let failed = failure(previous, "exact failure", 37) with { ConversationOutput.publish(event) => { resume collect(event); } };
    let expected_failure = __FAILURE_EXPECTED__;
    if failed != expected_failure { abort("whole failure Turn differs"); }
    println("PASS failure_status");
    return 0;
}
public flow backend_abort(args: Array<string>) -> i32 {
    let previous = __EMPTY__;
    let result = emit(previous, "user", "input", "", "no returned State") with {
        ConversationOutput.publish(_) => { println("PORT backend_abort publish"); abort("D3_EXPECTED_OUTPUT_ABORT"); }
    };
    println("UNREACHABLE output abort returned State");
    return 0;
}
