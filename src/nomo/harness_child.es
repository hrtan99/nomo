module nomo.harness_child;

import std.text.trim;
import nomo.conversation.Event;
import nomo.stub.{next, dispatch};
import nomo.harness_contract.{ChildTask, ChildResult, child_error, fixed_refusal, safe_text};

flow refused(task: ChildTask, used: i32, text: string) -> ChildResult {
    let safe = if fixed_refusal(text) { text } else { "invalid stub response" };
    return ChildResult { id = task.id, status = "refused", text = safe, used = used };
}

// A synchronous Etas agent runner: decisions and the one pure fake tool are real
// calls, not precomputed answers. The supplied selected context stays unchanged.
public flow run(task: ChildTask) -> ChildResult {
    let invalid = child_error(task);
    if invalid != "" {
        return ChildResult { id = task.id, status = "refused", text = invalid, used = 0 };
    }
    var history: Array<Event> = [];
    for text in task.context limit Iterations(4) {
        history = history.push(Event { role = "user", kind = "input", name = "", text = text });
    }
    let request = trim(task.task);
    var used: i32 = 0;
    var has_result = false;
    var result = "";
    while used < task.allowance limit Iterations(3) {
        used = used + 1;
        let reply = next(request, history, has_result, result);
        if reply.kind == "error" { return refused(task, used, reply.text); }
        if reply.kind == "final" {
            if !safe_text(reply.text, 1152) { return refused(task, used, "invalid child output"); }
            return ChildResult { id = task.id, status = "completed", text = reply.text, used = used };
        }
        if reply.kind != "tool" || has_result { return refused(task, used, "invalid stub response"); }
        // Refuse an unpermitted selection before dispatch and its second charge.
        if reply.tool != "echo" { return refused(task, used, "unknown tool"); }
        if used >= task.allowance { return refused(task, used, "child step limit exhausted"); }
        used = used + 1;
        let outcome = dispatch(reply.tool, reply.text);
        if !outcome.ok { return refused(task, used, outcome.text); }
        result = outcome.text;
        has_result = true;
    }
    return refused(task, used, "child step limit exhausted");
}
