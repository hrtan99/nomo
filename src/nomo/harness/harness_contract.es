module nomo.harness.harness_contract;

import std.collections.len as count;
import std.text.{char_count as len, trim};
import nomo.core.text.{printable, input_error};

// HARNESS-001A: copied selected data, never Host handles or delegated authority.
public type Job = { task: string, context: Array<string>, maximum: i32, spent: i32 };
public type ChildTask = { id: string, depth: i32, allowance: i32, task: string, context: Array<string> };
public type ChildResult = { id: string, status: string, text: string, used: i32 };
public type Ledger = { maximum: i32, spent: i32, reserved: i32 };
public type Exchange = { sender: string, recipient: string, kind: string, child_id: string, text: string };
public type Outcome = { status: string, text: string, ledger: Ledger, messages: Array<Exchange> };
public type Reservation = { job: Job, child: ChildTask, ledger: Ledger };

public flow task_error(task: string, context: Array<string>) -> string {
    if len(task) == 0 || len(task) > 256 || !printable(task) || trim(task) == "" {
        return "invalid bounded child task";
    }
    if input_error(task) != "" { return "invalid bounded child task"; }
    if count(context) > 4 { return "invalid selected context"; }
    var characters: usize = 0;
    for item in context limit Iterations(4) {
        if len(item) == 0 || len(item) > 256 || !printable(item) { return "invalid selected context"; }
        characters = characters + len(item);
    }
    if characters > 1024 { return "invalid selected context"; }
    return "";
}

public flow child_error(task: ChildTask) -> string {
    if task.id != "child-1" || task.depth != 1 || task.allowance != 3 { return "invalid child envelope"; }
    return task_error(task.task, task.context);
}

public flow fixed_refusal(text: string) -> bool {
    return text == "no prior completed context" || text == "stub failure" ||
        text == "expected tool:NAME:TEXT (no extra colons)" || text == "unknown tool" ||
        text == "fake tool failure" || text == "invalid stub response" ||
        text == "child step limit exhausted" || text == "invalid child output";
}

// The accepted whole-input printable helper is capped at 1,026 iterations.
// Check individual characters here so the larger bounded answers stay checked.
public flow safe_text(text: string, maximum: usize) -> bool {
    if maximum > 1280 || len(text) == 0 || len(text) > maximum { return false; }
    for codepoint in std.text.chars(text) limit Iterations(1282) { let character = std.text.from_char(codepoint);
        if !printable(character) { return false; }
    }
    return true;
}
