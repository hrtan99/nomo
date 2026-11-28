module nomo.domain.harness.delegation;

import nomo.core.conversation.Event;
import nomo.domain.limits.{context_bytes, message_bytes};
import nomo.domain.text.{input_error, text_printable};
import std.text.{char_count, split, starts_with, trim};

// Admission is effect-free. Err means no child, message or accounting mutation.
public flow admit(job: Job) -> Result<Reservation, string> {
    if job.maximum < 1 || job.maximum > 16 || job.spent < 0 || job.spent > job.maximum {
        return Err("invalid parent step ledger");
    }
    let invalid = task_error(job.task, job.context);
    if invalid != "" { return Err(invalid); }
    if job.maximum - job.spent < 5 { return Err("insufficient shared step budget"); }
    return Ok(Reservation { job,
        child = ChildTask { id = "child-1", depth = 1, allowance = 3, task = job.task, context = job.context },
        ledger = Ledger { maximum = job.maximum, spent = job.spent + 1, reserved = 4 } });
}

flow aggregate(reservation: Reservation, result: ChildResult) -> Outcome {
    var status = "refused";
    var body = "invalid child result";
    var used: i32 = 3;
    if result.id == "child-1" && (result.status == "completed" || result.status == "refused") &&
        result.used >= 1 && result.used <= 3 && safe_text(result.text, 1152) &&
        (result.status == "completed" || fixed_refusal(result.text)) {
        status = result.status;
        body = result.text;
        used = result.used;
    }
    var kind = "error";
    var final = "child refused: " + body;
    if status == "completed" { kind = "result"; final = "child result: " + body; }
    // Task<=256, child body<=1152, final<=1167: three messages total<=2575.
    let messages = [
        Exchange { sender = "main", recipient = "child-1", kind = "request", child_id = "child-1", text = reservation.child.task },
        Exchange { sender = "child-1", recipient = "main", kind, child_id = "child-1", text = body },
        Exchange { sender = "main", recipient = "main", kind = "consume", child_id = "child-1", text = final },
    ];
    return Outcome { status, text = final, messages,
        ledger = Ledger { maximum = reservation.job.maximum, spent = reservation.ledger.spent + used + 1, reserved = 0 } };
}

public flow settle(reservation: Reservation, result: ChildResult) -> Result<Outcome, string> {
    let expected = match admit(reservation.job) {
        Ok(value) => value, Err(error) => { return Err(error); }
    };
    if child_error(reservation.child) != "" || reservation != expected { return Err("invalid reservation"); }
    return Ok(aggregate(reservation, result));
}

// HARNESS-001A: copied selected data, never Host handles or delegated authority.
public type Job = { task: string, context: Array<string>, maximum: i32, spent: i32 };

public type ChildTask = { id: string, depth: i32, allowance: i32, task: string, context: Array<string> };

public type ChildResult = { id: string, status: string, text: string, used: i32 };

public type Ledger = { maximum: i32, spent: i32, reserved: i32 };

public type Exchange = { sender: string, recipient: string, kind: string, child_id: string, text: string };

public type Outcome = { status: string, text: string, ledger: Ledger, messages: Array<Exchange> };

public type Reservation = { job: Job, child: ChildTask, ledger: Ledger };

public flow task_error(task: string, context: Array<string>) -> string {
    if char_count(task) == 0 || char_count(task) > message_bytes() || !text_printable(task) || trim(task) == "" {
        return "invalid bounded child task";
    }
    if input_error(task) != "" { return "invalid bounded child task"; }
    if context.len() > 4 { return "invalid selected context"; }
    var characters: usize = 0;
    @limits([Iterations(4)]) for item in context {
        if char_count(item) == 0 || char_count(item) > message_bytes() || !text_printable(item) { return "invalid selected context"; }
        characters = characters + char_count(item);
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
    return maximum <= message_bytes() && text != "" && char_count(text) <= maximum && text_printable(text);
}

// The only adapter in this slice: deterministic data in, deterministic data out.
public flow next(request: string, history: Array<Event>, has_result: bool, result: string) -> Reply {
    if has_result { return Reply { kind = "final", tool = "", text = "stub received: " + result }; }
    if request == "recall" || request == "recall:user" {
        var remembered = "";
        @limits([Iterations(32)]) for event in history {
            if request == "recall" && event.role == "tool" && event.kind == "complete" { remembered = event.text; }
            if request == "recall:user" && event.role == "user" { remembered = event.text; }
        }
        if remembered == "" { return Reply { kind = "error", tool = "", text = "no prior completed context" }; }
        return Reply { kind = "final", tool = "", text = "remembered: " + remembered };
    }
    if request == "stub:fail" { return Reply { kind = "error", tool = "", text = "stub failure" }; }
    if starts_with(request, "tool:") {
        let parts = split(request, ":");
        if parts.len() != 3 || parts[1] == "" || parts[2] == "" {
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

public type Reply = { kind: string, tool: string, text: string };

public type ToolResult = { ok: bool, text: string };
