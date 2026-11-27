module nomo.domain.harness.harness_contract;

import nomo.domain.context.large_context.{message_bytes, context_bytes};
import std.text.{char_count as len, trim};
import nomo.domain.text.text.{printable, input_error};

// HARNESS-001A: copied selected data, never Host handles or delegated authority.
public type Job = { task: string, context: Array<string>, maximum: i32, spent: i32 };

public type ChildTask = { id: string, depth: i32, allowance: i32, task: string, context: Array<string> };

public type ChildResult = { id: string, status: string, text: string, used: i32 };

public type Ledger = { maximum: i32, spent: i32, reserved: i32 };

public type Exchange = { sender: string, recipient: string, kind: string, child_id: string, text: string };

public type Outcome = { status: string, text: string, ledger: Ledger, messages: Array<Exchange> };

public type Reservation = { job: Job, child: ChildTask, ledger: Ledger };

public flow task_error(task: string, context: Array<string>) -> string {
    if len(task) == 0 || len(task) > message_bytes() || !printable(task) || trim(task) == "" {
        return "invalid bounded child task";
    }
    if input_error(task) != "" { return "invalid bounded child task"; }
    if context.len() > 4 { return "invalid selected context"; }
    var characters: usize = 0;
    @limits([Iterations(4)]) for item in context {
        if len(item) == 0 || len(item) > message_bytes() || !printable(item) { return "invalid selected context"; }
        characters = characters + len(item);
    }
    if characters > context_bytes() { return "invalid selected context"; }
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

public flow safe_text(text: string, maximum: usize) -> bool {
    return maximum <= message_bytes() && text != "" && len(text) <= maximum && printable(text);
}
