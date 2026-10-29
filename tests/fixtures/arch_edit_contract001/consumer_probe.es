module app.contract_probe;

import std.io.println;
import std.text.{split, len};
import std.collections.len as count;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, parse, stringify};
import std.agent.message.Message;
import nomo.session.edit_operation.Binding;
import nomo.session.work_record.{Record, Captured, partial, confirm, validate, admit, same_record};
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_work_contract.Evidence;
import nomo.harness.harness_edit_contract.Context;
import nomo.tools.edit_contract.{Prepared, Selector, Confirmed, prepare_original};
import nomo.tools.edit_binding.bind;
import nomo.tools.edit_proposal.{Request, Proposal};
import nomo.entry.edit_context.{context, completed_context};

type Check = { label: string, passed: bool };
flow slash() -> string { return split("\\/", "")[1]; }
flow encoded(fields: Array<string>) -> string {
    let message = Message.new(fields); let conversion: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let data = match conversion { Some(value) => value.body, None() => { return ""; } };
    return match stringify(data) { Ok(value) => value, Err(_) => "" };
}
flow same_fields(body: string, fields: Array<string>) -> bool {
    let parsed = match parse(body) { Ok(value) => value, Err(_) => { return false; } };
    let message = Message.new(parsed); let conversion: Option<Message<Array<string>>> = message.cast<Array<string>>();
    return match conversion { Some(value) => value.body == fields, None() => false };
}
flow captured(value: Captured, binding: Binding, evidence: Evidence, task: string, before: string, after: string,
    target: string, replacement: string, summary: string, completed: bool) -> bool {
    return value.binding == binding && value.evidence == evidence && value.task == task && value.before == before &&
        value.after == after && value.target == target && value.replacement == replacement && value.summary == summary &&
        value.ledger.read == evidence.ledger && value.ledger.edit.steps == (if completed { 6 } else { 5 }) &&
        value.ledger.edit.calls == (if completed { 3 } else { 2 }) && value.ledger.edit.tokens == (if completed { 38912 } else { 36864 }) &&
        value.ledger.edit.native_tokens == (if completed { 163840 } else { 98304 }) && value.ledger.edit.boundaries == 3;
}
flow roundtrip(binding: Binding, evidence: Evidence, task: string, before: string, after: string, target: string,
    replacement: string, summary: string, partial_fields: Array<string>, complete_fields: Array<string>) -> bool {
    let prepared = match prepare_original(binding.path, before, target, replacement) { Ok(value) => value, Err(_) => { return false; } };
    let actual_binding = match bind(binding.id, binding.workspace, binding.path, prepared) { Ok(value) => value, Err(_) => { return false; } };
    if actual_binding != binding { return false; }
    let pending = match partial(binding, evidence, task, prepared) { Ok(value) => value, Err(_) => { return false; } };
    if pending.format != 1 || pending.phase != "summary-unconfirmed" || pending.binding != binding || !same_record(pending, pending) ||
        !same_fields(pending.body, partial_fields) || count(partial_fields) != 52 { return false; }
    let first = match validate(pending) { Ok(value) => value, Err(_) => { return false; } };
    if !captured(first, binding, evidence, task, before, after, target, replacement, "", false) { return false; }
    match admit(pending) { Ok(value) => { if !value { return false; } } Err(_) => { return false; } }
    let complete = match confirm(pending, summary) { Ok(value) => value, Err(_) => { return false; } };
    if complete.format != 1 || complete.phase != "summary-confirmed" || complete.binding != binding || same_record(pending, complete) ||
        !same_fields(complete.body, complete_fields) || byte_count(utf8_encode(complete.body)) > 65536 { return false; }
    let last = match validate(complete) { Ok(value) => value, Err(_) => { return false; } };
    if !captured(last, binding, evidence, task, before, after, target, replacement, summary, true) { return false; }
    return match confirm(complete, summary) { Ok(_) => false, Err(_) => true };
}
flow binding_refused(expected: string) -> bool {
    let prepared = Prepared { request = Request { path = "note.txt", original = "old", target = "old", replacement = "new" },
        proposal = Proposal { path = "note.txt", before = "old", after = "forged" } };
    return match bind("op", "owned", "note.txt", prepared) { Ok(_) => false, Err(error) => error == expected };
}
flow projected(selector: Selector, binding: Binding, before: string, after: string,
    initial: Context, completed: Context) -> bool {
    let confirmed = Confirmed { binding = binding, after = after };
    return context("child", selector, "request", "task", before) == initial &&
        completed_context("request", "task", before, confirmed) == completed;
}
flow checks() -> Array<Check> { return __CHECKS__; }
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(16) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(16) {
        if !item.passed { println("FAIL " + item.label); abort("edit contract consumer check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
