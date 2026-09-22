module nomo.tool_test;

import nomo.conversation.{fresh, add, Event};
import nomo.tool_agent.{tool_turn, fresh_tools, Session};
import std.io.println;
import std.collections.len;

flow main(args: Array<string>) -> i32 {
    let first = tool_turn("read:docs/a.txt", 3, 3, fresh_tools());
    if first.status != 0 || first.state.history.spent != 3 { abort("first turn accounting"); }
    let events = first.state.history.events;
    if events[2].role != "tool" || events[2].kind != "complete" { abort("completed event missing"); }
    if events[3].text != "read-only result: " + events[2].text { abort("result not fed to final"); }
    let second = tool_turn("read:missing.txt", 3, 3, first.state);
    if second.status != 4 || second.state.history.spent != 3 { abort("budget not preserved"); }
    println("STATE_OK");
    return 0;
}

flow after_tool(args: Array<string>) -> i32 {
    let first = tool_turn("read:docs/a.txt", 2, 3, fresh_tools());
    if first.status != 4 || first.state.history.spent != 2 || first.state.history.events[2].kind != "complete" { abort("lost completed result"); }
    println("AFTER_TOOL_OK");
    return 0;
}

flow capacity(args: Array<string>) -> i32 {
    var state = fresh();
    for i in [1, 2, 3, 4, 5, 6, 7] limit Iterations(7) {
        state = add(state, Event { role = "user", kind = "input", name = "", text = args[0] });
    }
    let result = tool_turn("read:missing.txt", 3, 3, Session { history = state, reserved = 0 });
    if result.status != 4 || result.state.history.spent != 0 || !result.state.history.stopped { abort("capacity not reserved"); }
    println("CAPACITY_OK");
    return 0;
}

flow scan_budget(args: Array<string>) -> i32 {
    let first = tool_turn("search:maxscan1.txt,maxscan2.txt:absent", 3, 16, fresh_tools());
    let second = tool_turn("search:maxscan1.txt,maxscan2.txt:absent", 3, 16, first.state);
    if second.status != 0 || second.state.reserved != 8192 { abort("scan reservation accounting"); }
    let third = tool_turn("read:missing.txt", 3, 16, second.state);
    if third.status != 4 || third.state.history.spent != 6 || third.state.reserved != 8192 { abort("scan reservation not enforced"); }
    println("SCAN_BUDGET_OK");
    return 0;
}

flow raw_refusal(args: Array<string>) -> i32 {
    let prior = add(fresh(), Event { role = "tool", kind = "complete", name = "read", text = "SAFE_PRIOR" });
    let result = tool_turn(args[0], 3, 3, Session { history = prior, reserved = 0 });
    let history = result.state.history;
    if result.status != 2 || history.spent != 0 || history.stopped { abort("invalid raw request charged or stopped"); }
    if result.state.reserved != 4096 { abort("conservative scan reservation changed"); }
    if len(history.events) != 2 || history.events[0] != prior.events[0] { abort("unsafe event or prior context changed"); }
    let error = history.events[1];
    if error.role != "error" || error.kind != "error" || error.name != "" || error.text != "expected printable ASCII single-line input" {
        abort("raw input stored instead of bounded rejection");
    }
    println("RAW_REFUSAL_OK");
    return 0;
}
