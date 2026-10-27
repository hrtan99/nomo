module nomo.entry.edit_context;

import std.io.println;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.harness.harness_edit_contract.Context;
import nomo.tools.edit_encoding.json;
import nomo.entry.edit_coordinator.{Selector, Confirmed};

public flow context(phase: string, selector: Selector, request: string, task: string, before: string) -> Context {
    return Context { phase = phase, request = request, task = task, id = selector.id, workspace = selector.workspace,
        path = selector.path, before = before, after = "", request_digest = "", before_digest = "", after_digest = "",
        before_bytes = byte_count(utf8_encode(before)), after_bytes = 0, completed = false };
}
public flow completed_context(request: string, task: string, before: string, outcome: Confirmed) -> Context {
    let selected = outcome.binding;
    return Context { phase = "aggregate", request = request, task = task, id = selected.id, workspace = selected.workspace,
        path = selected.path, before = before, after = outcome.after, request_digest = selected.request_digest,
        before_digest = selected.before_digest, after_digest = selected.after_digest,
        before_bytes = selected.before_bytes, after_bytes = selected.after_bytes, completed = true };
}
public flow recorded(selector: Selector) -> unit {
    println("EDIT completed " + selector.id + "; aggregation cannot change the recorded outcome; do not replay.");
    match json(["edit_status", "--id", selector.id, "--workspace", selector.workspace, "--path", selector.path]) {
        Ok(value) => { println("NEXT " + value); }
        Err(_) => { println("Recorded operation is available through edit_status with the same selectors."); }
    }
}
public flow display(prefix: string, text: string) -> unit {
    match json([text]) { Ok(value) => { println(prefix + value); } Err(error) => { abort(error); } }
}
