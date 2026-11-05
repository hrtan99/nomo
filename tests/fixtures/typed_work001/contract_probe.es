module app.contract_probe;

import std.io.println;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.edit_encoding.digest;
import nomo.model.model_tool_contract.{Action, decode_reply};
import nomo.model.model_tool_contract.Context as ToolContext;
import nomo.harness.harness_tool_contract.Context as ReadContext;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;
import nomo.harness.harness_edit_contract.Context as EditContext;
import nomo.harness.harness_work_contract.{Context, Evidence};
import nomo.harness.work_chain_model.{Input, ParentFacts, combined};
import nomo.harness.typed_work_contract.{Delegation, ReadAction, Answer, project_read_plan, project_read_action,
    project_read_final, project_read_aggregate, settle_read, project_edit_plan, project_edit_child, project_edit_aggregate};
import nomo.tools.edit_contribution.Contribution;
import nomo.harness.typed_work_reservation.{Policy, Envelope, Reservation, required, admit, advance, stop, reservation_error};

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow plan_context(phase: string) -> ReadContext {
    return ReadContext { phase = phase, request = "Change chosen using observed context", task = if phase == "plan" { "" } else { "Read context.txt" },
        result = if phase == "plan" { "" } else { "Observed supporting text." }, tool = if phase == "plan" { "" } else { "read" },
        outcome = if phase == "plan" { "" } else { "complete: supporting text" }, allowed = ["context.txt"] };
}
flow read_plan(text: string, phase: string, accepted: bool) -> bool {
    let value = Delegation { task = text };
    return match project_read_plan(plan_context(phase), value) { Ok(task) => accepted && task == text, Err(_) => !accepted };
}
flow read_action(operation: string, files: Array<string>, literal: string, allowed: Array<string>, final_only: bool, error: string) -> bool {
    let context = ToolContext { history = [], allowed = allowed, final_only = final_only };
    let value = ReadAction { operation = operation, files = files, literal = literal };
    return match project_read_action(context, value) {
        Ok(action) => error == "" && action.operation == operation && action.files == files && action.literal == literal && action.text == "",
        Err(invalid) => error != "" && invalid == error,
    };
}
flow legacy(raw: string, allowed: Array<string>, operation: string, error: string) -> bool {
    return match decode_reply(raw, allowed, false) { Ok(value) => error == "" && value.operation == operation, Err(value) => error != "" && value == error };
}
flow read_final(text: string, final_only: bool, accepted: bool) -> bool {
    let context = ToolContext { history = [], allowed = ["context.txt"], final_only = final_only };
    let value = Answer { text = text };
    return match project_read_final(context, value) {
        Ok(action) => accepted && action.operation == "final" && action.text == text && action.files == [] && action.literal == "",
        Err(_) => !accepted,
    };
}
flow read_summary(text: string, phase: string, accepted: bool) -> bool {
    let value = Answer { text = text };
    return match project_read_aggregate(plan_context(phase), value) { Ok(summary) => accepted && summary == text, Err(_) => !accepted };
}
flow settled(pending: Evidence, text: string, expected: Evidence, denied: bool) -> bool {
    let answer = Answer { text = text };
    return match settle_read(pending, answer) { Ok(value) => !denied && value == expected, Err(_) => denied };
}

flow facts() -> Array<ParentFacts> {
    return [ParentFacts { chain = "chain-one", root = "chain-one", id = "prior-turn", turn = 1, after_digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        request = "Prior request", read_task = "Read prior context", operation = "read", files = ["context.txt"], literal = "",
        outcome = "complete: prior observed context", result = "Prior child result", read_summary = "Prior read summary", final_summary = "Prior confirmed summary" }];
}
flow work(phase: string, before: string, after: string, changed_request: bool, completed: bool) -> Context {
    let request = "Change chosen using observed context";
    let previous = match digest(before) { Ok(value) => value, Err(error) => { abort(error); } };
    let next = match digest(after) { Ok(value) => value, Err(error) => { abort(error); } };
    let edit = EditContext { phase = phase, request = if changed_request { "Different request" } else { request },
        task = if phase == "plan" { "" } else { "Replace chosen with updated" }, id = "typed-work", workspace = "owned", path = "notes/report.txt",
        before = before, after = if phase == "aggregate" { after } else { "" },
        request_digest = if phase == "aggregate" { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } else { "" },
        before_digest = if phase == "aggregate" { previous } else { "" }, after_digest = if phase == "aggregate" { next } else { "" },
        before_bytes = byte_count(utf8_encode(before)), after_bytes = if phase == "aggregate" { byte_count(utf8_encode(after)) } else { 0 },
        completed = completed };
    let evidence = Evidence { request = request, task = "Read context.txt", operation = "read", files = ["context.txt"], literal = "",
        outcome = "complete: supporting text", result = "Observed supporting text.", summary = "Use actual supporting text.", allowed = ["context.txt"],
        ledger = ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    return Context { edit = edit, evidence = evidence };
}
flow edit_plan(text: string, phase: string, changed: bool, accepted: bool) -> bool {
    let input = Input { current = work(phase, "chosen", "updated", changed, false), parent = facts() };
    let value = Delegation { task = text };
    return match project_edit_plan(input, value) { Ok(task) => accepted && task == text, Err(_) => !accepted };
}
flow edit_child(before: string, target: string, replacement: string, phase: string, changed: bool, expected: string, accepted: bool) -> bool {
    let input = Input { current = work(phase, before, "", changed, false), parent = facts() };
    let value = Contribution { target = target, replacement = replacement };
    return match project_edit_child(input, value) {
        Ok(proposal) => accepted && proposal.path == "notes/report.txt" && proposal.before == before && proposal.after == expected,
        Err(_) => !accepted,
    };
}
flow edit_summary(text: string, completed: bool, changed: bool, accepted: bool) -> bool {
    let input = Input { current = work("aggregate", "chosen", "updated", changed, completed), parent = facts() };
    let value = Answer { text = text };
    return match project_edit_aggregate(input, value) { Ok(summary) => accepted && summary == text, Err(_) => !accepted };
}
flow parents_preserved(phase: string) -> bool {
    let current = work(phase, "chosen", "updated", false, phase == "aggregate");
    let selected = facts();
    let input = combined(current, selected);
    return input.current == current && input.parent == selected && input.parent[0].id == "prior-turn" &&
        input.parent[0].outcome == "complete: prior observed context" && input.current.evidence.outcome == "complete: supporting text";
}

flow admission(policy: Policy, maximum: Envelope, accepted: bool) -> bool {
    return match admit(policy, maximum) {
        Ok(value) => accepted && value.stages == 0 && !value.stopped && reservation_error(value) == "" &&
            value.reserved.logical == 7 && value.reserved.native_requests == 63 && value.reserved.generation == 423936 &&
            value.reserved.http_attempts == 63 * policy.http_attempts && value.attempted.logical == 0 &&
            value.attempted.native_requests == 0 && value.attempted.http_attempts == 0 && value.attempted.generation == 0,
        Err(_) => !accepted,
    };
}
flow rejected(state: Reservation) -> bool {
    let next = match advance(state) { Ok(_) => false, Err(_) => true };
    let halted = match stop(state) { Ok(_) => false, Err(_) => true };
    return reservation_error(state) != "" && next && halted;
}
flow progression(attempts: i32) -> bool {
    let policy = Policy { repair_rounds = 8, http_attempts = attempts };
    let maximum = Envelope { logical = 7, native_requests = 63, http_attempts = 189, generation = 423936 };
    var state = match admit(policy, maximum) { Ok(value) => value, Err(_) => { return false; } };
    let generations = [18432, 36864, 55296, 73728, 110592, 405504, 423936];
    var index: usize = 0;
    while index < 7 limit Iterations(7) {
        let next = match advance(state) { Ok(value) => value, Err(_) => { return false; } };
        if next.stages != state.stages + 1 || next.reserved != state.reserved || next.maximum != state.maximum ||
            next.attempted.logical != next.stages || next.attempted.native_requests != next.stages * 9 ||
            next.attempted.http_attempts != next.stages * 9 * attempts || next.attempted.generation != generations[index] { return false; }
        let halted = match stop(next) { Ok(value) => value, Err(_) => { return false; } };
        if !halted.stopped || halted.attempted != next.attempted || halted.reserved != next.reserved || halted.maximum != next.maximum { return false; }
        let resumed = match advance(halted) { Ok(_) => true, Err(_) => false }; if resumed { return false; }
        state = next; index = index + 1;
    }
    return match advance(state) { Ok(_) => false, Err(_) => state.attempted == state.reserved && reservation_error(state) == "" };
}
flow stopped_without_attempt() -> bool {
    let policy = Policy { repair_rounds = 8, http_attempts = 1 };
    let maximum = match required(policy) { Ok(value) => value, Err(_) => { return false; } };
    let initial = match admit(policy, maximum) { Ok(value) => value, Err(_) => { return false; } };
    let halted = match stop(initial) { Ok(value) => value, Err(_) => { return false; } };
    let refused = match advance(halted) { Ok(_) => false, Err(_) => true };
    return refused && halted.reserved == initial.reserved && halted.attempted == initial.attempted && halted.stages == 0;
}

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !item.passed { println("FAIL " + item.label); abort("typed work pure contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
