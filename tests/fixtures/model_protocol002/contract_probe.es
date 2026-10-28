module app.contract_probe;

import std.io.println;
import std.agent.message.Message;
import std.json.{JsonValue, parse, stringify};
import std.codec.text.utf8_encode;
import std.bytes.len as byte_count;
import nomo.harness.harness_edit_contract.Context as EditContext;
import nomo.harness.harness_work_contract.{Context as WorkContext, context_error as work_context_error};
import std.text.{split, contains, len};
import nomo.core.text.printable;
import nomo.harness.harness_model_contract.{decode_read_plan, read_aggregate_error};
import nomo.harness.harness_model_contract.decode_plan as legacy_read_plan;
import nomo.model.model_tool_contract.{decode_work_reply, decode_reply};
import nomo.harness.harness_edit_contract.{decode_work_plan, decode_work_edit, work_summary_error};
import nomo.harness.harness_edit_contract.decode_plan as legacy_edit_plan;
import nomo.harness.harness_edit_contract.decode_edit as legacy_edit_child;
import nomo.harness.model_plan_diagnostic.{response_error, response_text};
import nomo.tools.edit_proposal.{Request, propose};
import nomo.session.work_chain.{Record, initial, publish_partial, confirm, successor, validate, turn_caps, summary_reservation};
import nomo.session.work_chain_journal.Record as Journal;
import nomo.session.work_record.partial;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.harness.harness_work_contract.Evidence;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.entry.work_chain_display.render;

type Check = { label: string, passed: bool };
flow slash() -> string { return split("\\/", "")[1]; }
flow checks() -> Array<Check> { return __CHECKS__; }
flow issue(phase: string, raw: string) -> string {
    if phase == "read-plan" { return match decode_read_plan(raw) { Ok(_) => "", Err(error) => error }; }
    if phase == "read-child-action" || phase == "read-child-final" {
        return match decode_work_reply(raw, ["a.txt", "b.txt"], phase == "read-child-final") { Ok(_) => "", Err(error) => error };
    }
    if phase == "read-aggregate" { return read_aggregate_error(raw); }
    if phase == "edit-plan" { return match decode_work_plan(raw) { Ok(_) => "", Err(error) => error }; }
    if phase == "edit-child" { return match decode_work_edit(raw) { Ok(_) => "", Err(error) => error }; }
    return work_summary_error(raw);
}
flow legacy_error(kind: string, raw: string, expected: string) -> bool {
    var actual = "";
    if kind == "read-plan" { actual = match legacy_read_plan(raw) { Ok(_) => "", Err(value) => value }; }
    else if kind == "edit-plan" { actual = match legacy_edit_plan(raw) { Ok(_) => "", Err(value) => value }; }
    else { actual = match legacy_edit_child(raw) { Ok(_) => "", Err(value) => value }; }
    return actual == expected;
}
flow legacy_final(raw: string, expected: string) -> bool {
    return match decode_reply(raw, ["a.txt"], true) { Ok(value) => value.operation == "final" && value.text == expected, Err(_) => false };
}
flow refused(phase: string, raw: string) -> bool { return issue(phase, raw) != ""; }
flow diagnosed(phase: string, raw: string, expected: string) -> bool { return issue(phase, raw) == expected; }
flow plan(phase: string, raw: string, expected: string) -> bool {
    let decoded = if phase == "read-plan" { decode_read_plan(raw) } else { decode_work_plan(raw) };
    return match decoded { Ok(value) => value == expected, Err(_) => false };
}
flow action(raw: string, allowed: Array<string>, final_only: bool, operation: string, files: Array<string>, literal: string, text: string) -> bool {
    return match decode_work_reply(raw, allowed, final_only) {
        Ok(value) => value.operation == operation && value.files == files && value.literal == literal && value.text == text,
        Err(_) => false,
    };
}
flow action_refused(raw: string, allowed: Array<string>, final_only: bool) -> bool {
    return match decode_work_reply(raw, allowed, final_only) { Ok(_) => false, Err(_) => true };
}
flow edit(raw: string, target: string, replacement: string) -> bool {
    return match decode_work_edit(raw) { Ok(value) => value.target == target && value.replacement == replacement, Err(_) => false };
}
flow proposed(original: string, target: string, replacement: string, expected: string, accepted: bool) -> bool {
    let input = Request { path = "target.txt", original = original, target = target, replacement = replacement };
    return match propose(input) { Ok(value) => accepted && value.before == original && value.after == expected, Err(_) => !accepted };
}
flow formatted(raw: string, phase: string, maximum: usize, expected: string) -> bool {
    let value = response_text(raw, phase, "lab-qwen-", maximum);
    return value == expected && printable(value) && len(value) <= 384;
}
flow snippet(raw: string, phase: string, maximum: usize, required: Array<string>, forbidden: Array<string>) -> bool {
    let value = response_text(raw, phase, "lab-qwen-", maximum);
    if !printable(value) || len(value) > 384 { return false; }
    for item in required limit Iterations(16) { if !contains(value, item) { return false; } }
    for item in forbidden limit Iterations(16) { if contains(value, item) { return false; } }
    return true;
}
// Nomo typed-data round trip only; no Provider or Model boundary is invoked.
flow typed_context_roundtrip(before: string) -> bool {
    let request = "replace selected literal";
    let edit = EditContext { phase = "child", request = request, task = "Replace selected literal \"quote\" 雪", id = "literal-op", workspace = "owned", path = "target.txt",
        before = before, after = "", request_digest = "", before_digest = "", after_digest = "",
        before_bytes = byte_count(utf8_encode(before)), after_bytes = 0, completed = false };
    let evidence = Evidence { request = request, task = "Read context.txt", operation = "read", files = ["context.txt"], literal = "",
        outcome = "complete: observed context", result = "Observed context.", summary = "Use actual context.", allowed = ["context.txt"],
        ledger = ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    let value = WorkContext { edit = edit, evidence = evidence };
    if work_context_error(value) != "" { return false; }
    let message = Message.new(value); let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let json = match converted { Some(item) => item.body, None() => { return false; } };
    let encoded = match stringify(json) { Ok(item) => item, Err(_) => { return false; } };
    let parsed = match parse(encoded) { Ok(item) => item, Err(_) => { return false; } };
    let restored_message = Message.new(parsed); let restored: Option<Message<WorkContext>> = restored_message.cast<WorkContext>();
    return match restored { Some(item) => item.body == value && item.body.edit.before == before && item.body.edit.before_bytes == byte_count(utf8_encode(before)), None() => false };
}

// Typed values exercise projections only: no store/admission/atomic/Host call.
flow post_atomic_failure(summary: string) -> bool {
    let row = match initial("root-op", "owned", "target.txt", "update target from context", ["context.txt"], turn_caps()) { Ok(value) => value, Err(_) => { return false; } };
    let prepared = match prepare_original("target.txt", "old\n", "old", "blue") { Ok(value) => value, Err(_) => { return false; } };
    let binding = match bind("root-op", "owned", "target.txt", prepared) { Ok(value) => value, Err(_) => { return false; } };
    let evidence = Evidence { request = "update target from context", task = "Read context.txt", operation = "read", files = ["context.txt"],
        literal = "", outcome = "complete: blue", result = "Seen: complete: blue", summary = "Use the context result", allowed = ["context.txt"],
        ledger = ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    let work = match partial(binding, evidence, "replace selected text", prepared) { Ok(value) => value, Err(_) => { return false; } };
    let pending = match publish_partial(row, work) { Ok(value) => value, Err(_) => { return false; } };
    let journal = Journal { format = 2, chain = "root-op", turn = 1, phase = "completed", binding = binding };
    if work_summary_error(summary) == "" || validate(pending) != "" || pending.phase != "summary-unconfirmed" || pending.reserved != summary_reservation() { return false; }
    match confirm(pending, summary) { Ok(_) => { return false; } Err(_) => {} }
    match successor(pending, "opaque-version", "child-op", "update target from context", ["context.txt"], turn_caps()) { Ok(_) => { return false; } Err(_) => {} }
    let lines = match render(pending, Some(journal)) { Ok(value) => value, Err(_) => { return false; } };
    var shown_partial = false; var shown_completed = false;
    for line in lines limit Iterations(16) {
        if contains(line, "summary-unconfirmed") { shown_partial = true; }
        if contains(line, "JOURNAL ") && contains(line, "completed") { shown_completed = true; }
    }
    return shown_partial && shown_completed && journal.binding == binding && prepared.proposal.after == "blue\n" && pending.remaining == row.remaining;
}
public flow pure_probe() -> bool { for item in checks() limit Iterations(96) { if !item.passed { return false; } } return true; }
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(96) {
        if !item.passed { println("FAIL " + item.label); abort("seven-boundary contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
