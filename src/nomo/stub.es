module nomo.stub;

import std.collections.len;
import std.text.{split, starts_with};
import nomo.conversation.Event;

public type Reply = { kind: string, tool: string, text: string };
public type ToolResult = { ok: bool, text: string };

// The only adapter in this slice: deterministic data in, deterministic data out.
public flow next(request: string, history: Array<Event>, has_result: bool, result: string) -> Reply {
    if has_result { return Reply { kind = "final", tool = "", text = "stub received: " + result }; }
    if request == "recall" || request == "recall:user" {
        var remembered = "";
        for event in history limit Iterations(32) {
            if request == "recall" && event.role == "tool" && event.kind == "complete" { remembered = event.text; }
            if request == "recall:user" && event.role == "user" { remembered = event.text; }
        }
        if remembered == "" { return Reply { kind = "error", tool = "", text = "no prior completed context" }; }
        return Reply { kind = "final", tool = "", text = "remembered: " + remembered };
    }
    if request == "stub:fail" { return Reply { kind = "error", tool = "", text = "stub failure" }; }
    if starts_with(request, "tool:") {
        let parts = split(request, ":");
        if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
            return Reply { kind = "error", tool = "", text = "expected tool:NAME:TEXT (no extra colons)" };
        }
        return Reply { kind = "tool", tool = parts[1], text = parts[2] };
    }
    return Reply { kind = "final", tool = "", text = "stub: " + request };
}

public flow dispatch(name: string, input: string) -> ToolResult {
    if name != "echo" { return ToolResult { ok = false, text = "unknown tool" }; }
    if input == "fail" { return ToolResult { ok = false, text = "fake tool failure" }; }
    return ToolResult { ok = true, text = input };
}
