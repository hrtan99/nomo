module nomo.harness.edit_context;

import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.harness.harness_edit_contract.Context;
import nomo.tools.edit_contract.{Selector, Confirmed};

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
