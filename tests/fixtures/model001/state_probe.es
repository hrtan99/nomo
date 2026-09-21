module nomo.model_test;

import nomo.conversation.{Event, fresh, add};
import nomo.provider.model_turn;
import std.collections.len;

flow main(args: Array<string>) -> i32 {
    var state = fresh();
    if args[0] == "tool_context" {
        state = add(state, Event { role = "tool", kind = "complete", name = "echo", text = "GOOD" });
        state = add(state, Event { role = "tool", kind = "error", name = "echo", text = "BAD" });
        let result = model_turn("recall", 1, 1, state);
        if result.status != 0 || result.state.spent != 1 || len(result.state.events) != 5 { abort("test context state mismatch"); }
        return 0;
    }
    var count: i32 = 31;
    var text = "x";
    if args[0] == "content" { count = 8; text = args[1]; }
    var index: i32 = 0;
    while index < count limit Iterations(31) {
        state = add(state, Event { role = "user", kind = "input", name = "", text = text });
        index = index + 1;
    }
    let result = model_turn("hello", 1, 1, state);
    if result.status != 4 || !result.state.stopped || result.state.spent != 0 { abort("test capacity state mismatch"); }
    if len(result.state.events) != len(state.events) + 1 { abort("test terminal reservation mismatch"); }
    return 0;
}
