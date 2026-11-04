module app.large_input;

import std.io.println;
import nomo.core.conversation.{Event, capacity_error, fresh};
import nomo.model.tool_context.Context;
import nomo.context.preflight.{Refusal, measure_context};
import nomo.context.selection.{EventPolicy, select};
import nomo.session.chat_session_contract.fresh_events;
import nomo.harness.natural_work_chat.run;

public flow probe(args: Array<string>) -> i32 {
    var text = "0123456789abcdef0123456789abcdef";
    var i: i32 = 0;
    while i < 13 limit Iterations(13) { text = text + text; i = i + 1; }
    let task = Event { role = "user", kind = "input", name = "", text = "Read the task" };
    let item = Event { role = "user", kind = "context", name = "history", text = text };
    let history = [task, item, item, item, item, item];
    let context = Context { history = history, allowed = ["note.txt"], final_only = false };
    match measure_context(context, 1048576) { Err(error) => { if error != Refusal.TooLarge { abort("unexpected context refusal"); } } _ => { abort("old 1 MiB bound should refuse"); } }
    let measured = match measure_context(context, 8388608) { Ok(value) => value, Err(_) => { abort("large context was refused"); } };
    if measured.encoded_bytes <= 1048576 || measured.tokens != None() { abort("large context measurement is incorrect"); }
    let selected = match select(context, [EventPolicy.Task, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required, EventPolicy.Required], 8388608) { Ok(value) => value, Err(_) => { abort("large context selection refused"); } };
    if selected.omitted_count != 0 || selected.context != context { abort("required context was omitted"); }
    if capacity_error(fresh(), 6, measured.encoded_bytes) != "" { abort("large conversation capacity refused"); }
    let result = run("Read the task", ["note.txt"], fresh_events().invocation, history, None(), None(), [], 0, false);
    if result.status != 0 || !result.resolved { abort("large model input was refused"); }
    println("PASS large input reached model and required data remained intact");
    return 0;
}
