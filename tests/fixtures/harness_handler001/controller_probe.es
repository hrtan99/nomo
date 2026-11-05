module app.harness_handler_probe;

import std.io.println;
import std.text.char_count as len;
import nomo.core.conversation.{Event, State, add, fresh as empty_history};
import nomo.model.model_tool_contract.{Session, LoopTurn, Context as ChildContext, question_error, default_limits};
import nomo.agent.model_tool.run_loop_with;
import nomo.harness.harness_tool_contract.{Context, Ledger, fresh};
import nomo.harness.harness_model_contract.decode_plan;
import nomo.harness.harness_model_tools.{Report, Failure, run_context};
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyChildModel, LegacyEditStages};
import nomo.harness.harness_work_contract.{Context as WorkContext, Evidence, Ledger as WorkLedger};
import nomo.harness.harness_edit_contract.{Context as EditContext, Ledger as EditLedger};
import nomo.entry.harness_work_entry.{Completed, Summary, Failure as WorkFailure, finish_summary};
import nomo.tools.edit_encoding.digest;

flow usage(steps: i32, calls: i32, tools: i32) -> Ledger {
    return Ledger { steps = steps, calls = calls, tokens = calls * 2048, tools = tools, scan = tools * 4096 };
}
flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
// Synthetic child returns exercise the real parent's inspect/settle guards.
// They do not establish a File read, native Model call or typed-record response.
flow child(original: string, tool: bool, failure: bool) -> LoopTurn {
    var events = [event("user", "context", "original", original), event("user", "input", "", "T"), event("model", "text", "qwen", "")];
    if tool {
        events = events.push(event("model", "request", "read", "[\"read\",\"a.txt\"]"));
        events = events.push(event("tool", "complete", "read", "complete: blue<LF>"));
        events = events.push(event("model", "text", "qwen", ""));
    }
    events = events.push(if failure { event("error", "error", "", "fixture child refused") } else { event("assistant", "final", "", "Seen blue") });
    var characters: usize = 0;
    for item in events limit Iterations(7) { characters = characters + len(item.name) + len(item.text); }
    let calls: usize = if tool { 2 } else { 1 };
    let tools: usize = if tool { 1 } else { 0 };
    return LoopTurn { status = if failure { 3 } else { 0 }, state = Session {
        history = State { events = events, characters = characters, spent = if tool { 3 } else { 1 }, stopped = false },
        calls = calls, tokens = calls * 2048, tools = tools, scan = tools * 4096 } };
}
flow mismatch(error: string) -> Result<Report, Failure> {
    return Err(Failure { state = fresh(), error = error, resolved = false });
}
flow deterministic(request: string, initial: Ledger, chosen: LoopTurn, plan: string, answer: string, require_tool: bool, compatible: bool) -> Result<Report, Failure> {
    return run_context(request, ["a.txt"], initial, "fixture-", require_tool, compatible, false, false) with {
        LegacyStringStages.main(context) => {
            let expected = Context { phase = context.phase, request = "Q", task = if context.phase == "plan" { "" } else { "T" },
                result = if context.phase == "plan" { "" } else { "Seen blue" },
                tool = if context.phase == "aggregate" && chosen.state.tools == 1 { "read" } else { "" },
                outcome = if context.phase == "aggregate" && chosen.state.tools == 1 { "complete: blue<LF>" } else { "" }, allowed = ["a.txt"] };
            if context != expected { finish mismatch("fixture main context changed"); }
            let response = if context.phase == "plan" { plan } else { answer };
            resume response;
        }
        LegacyStringStages.child(task, allowed, selected) => {
            let expected = add(empty_history(), event("user", "context", "original", "Q"));
            if task != "T" || allowed != ["a.txt"] || selected != expected { finish mismatch("fixture selected child context changed"); }
            resume chosen;
        }
    };
}
// Every dispatch in these precondition cases terminates the handler immediately.
flow no_dispatch(request: string, initial: Ledger) -> Result<Report, Failure> {
    return run_context(request, ["a.txt"], initial, "trap-", false, false, false, false) with {
        LegacyStringStages.main(_) => { finish mismatch("UNEXPECTED main dispatch"); }
        LegacyStringStages.child(_, _, _) => { finish mismatch("UNEXPECTED child dispatch"); }
    };
}
flow child_controller(raw: string, previous: Session, trap: bool) -> LoopTurn {
    return run_loop_with(raw, ["a.txt"], default_limits(), previous, false, false) with {
        LegacyChildModel.infer(value) => {
            let seeded = add(previous.history, event("user", "input", "", raw));
            let expected = ChildContext { history = seeded.events, allowed = ["a.txt"], final_only = false };
            if trap || value != expected { finish LoopTurn { state = previous, status = 99 }; }
            resume "[\"final\",\"Seen blue\"]";
        }
    };
}
flow selected_child() -> Session {
    return Session { history = add(empty_history(), event("user", "context", "original", "Q")), calls = 0, tokens = 0, tools = 0, scan = 0 };
}
flow completed() -> Completed {
    let read = usage(7, 4, 1);
    let request_digest = match digest("Q") { Ok(value) => value, Err(error) => { abort(error); } };
    let before_digest = match digest("old\n") { Ok(value) => value, Err(error) => { abort(error); } };
    let after_digest = match digest("blue\n") { Ok(value) => value, Err(error) => { abort(error); } };
    let edit = EditContext { phase = "aggregate", request = "Q", task = "Replace old with blue", id = "fixture", workspace = "synthetic", path = "a.txt",
        before = "old\n", after = "blue\n", request_digest = request_digest, before_digest = before_digest, after_digest = after_digest, before_bytes = 4, after_bytes = 5, completed = true };
    let evidence = Evidence { request = "Q", task = "T", operation = "read", files = ["a.txt"], literal = "", outcome = "complete: blue<LF>", result = "Seen blue", summary = "Answer", allowed = ["a.txt"], ledger = read };
    return Completed { context = WorkContext { edit = edit, evidence = evidence }, state = WorkLedger { read = read,
        edit = EditLedger { steps = 5, calls = 2, tokens = 36864, native_tokens = 98304, boundaries = 3 } } };
}
flow summary_mismatch(state: WorkLedger, error: string) -> Result<Summary, WorkFailure> {
    return Err(WorkFailure { state = state, error = error });
}
flow summary_controller(value: Completed, answer: string, trap: bool) -> Result<Summary, WorkFailure> {
    let log = (name: string, state: WorkLedger) => {};
    return finish_summary(value, log, true, false) with {
        LegacyEditStages.plan(_) => { finish summary_mismatch(value.state, "UNEXPECTED edit plan"); }
        LegacyEditStages.child(_) => { finish summary_mismatch(value.state, "UNEXPECTED edit child"); }
        LegacyEditStages.aggregate(context) => {
            if trap || context != value.context { finish summary_mismatch(value.state, "UNEXPECTED edit aggregate"); }
            resume answer;
        }
    };
}
flow accepted(value: Result<Report, Failure>, expected: Ledger) -> bool {
    return match value { Ok(report) => report.request == "Q" && report.task == "T" && report.answer == "Answer" &&
        report.observed.result == "Seen blue" && report.ledger == expected, Err(_) => false };
}
flow refused(value: Result<Report, Failure>, expected: Ledger, resolved: bool, error: string) -> bool {
    return match value { Ok(_) => false, Err(failure) => failure.state == expected && failure.resolved == resolved && failure.error == error };
}
flow verify(label: string, valid: bool) -> unit {
    if !valid { println("FAIL " + label); abort("same-controller Handler fixture failed"); }
    println("PASS " + label);
}
flow parent_groups() -> unit {
    let direct = child("Q", false, false); let read = child("Q", true, false);
    let plan = "[\"delegate\",\"T\"]";
    verify("direct child shares actual controller", accepted(deterministic("Q", fresh(), direct, plan, "Answer", false, false), usage(5, 3, 0)));
    verify("complete tool outcome reaches aggregate", accepted(deterministic("Q", fresh(), read, plan, "Answer", true, false), usage(7, 4, 1)));
    verify("compatible decoder remains explicit policy", accepted(deterministic("Q", fresh(), read, "\n[\"delegate\", \"T\"]\n", "Answer", true, true), usage(7, 4, 1)));
    verify("invalid request precedes dispatch", refused(no_dispatch("", fresh()), fresh(), true, question_error("")));
    let exhausted = usage(7, 4, 1);
    verify("exhausted reservation precedes dispatch", refused(no_dispatch("Q", exhausted), exhausted, true, "shared reservation exhausted"));
    let bad_plan = match decode_plan("not JSON") { Ok(_) => "unexpected valid fixture", Err(error) => error };
    verify("bad plan retains attempted call", refused(deterministic("Q", fresh(), direct, "not JSON", "Answer", false, false), usage(1, 1, 0), true, bad_plan));
    verify("untrusted child metadata stays unresolved", refused(deterministic("Q", fresh(), child("WRONG", false, false), plan, "Answer", false, false), usage(2, 1, 0), false, "child original request or task history changed"));
    verify("failed child never aggregates", refused(deterministic("Q", fresh(), child("Q", false, true), plan, "Answer", false, false), usage(3, 2, 0), true, "child returned failure; no aggregation"));
    verify("work still requires an actual tool return", refused(deterministic("Q", fresh(), direct, plan, "Answer", true, false), usage(3, 2, 0), true, "work requires a successful read or search child"));
    verify("invalid aggregate retains final call", refused(deterministic("Q", fresh(), direct, plan, "", false, false), usage(5, 3, 0), true, "invalid bounded final answer"));
}

flow remaining_groups() -> unit {
    let direct = child("Q", false, false);
    let selected = selected_child();
    verify("child controller resumes deterministic model", child_controller("T", selected, false) == direct);
    let invalid_child = child_controller("", selected, true);
    verify("child input refuses before effect trap", invalid_child.status == 2 && invalid_child.state.calls == 0 && invalid_child.state.tokens == 0);
    let charged = Session { history = State { events = selected.history.events, characters = selected.history.characters, spent = 2, stopped = false }, calls = 2, tokens = 4096, tools = 0, scan = 0 };
    let exhausted_child = child_controller("T", charged, true);
    verify("child exhausted reservation never dispatches", exhausted_child.status == 4 && exhausted_child.state.calls == 2 && exhausted_child.state.tokens == 4096);
    let stopped = Session { history = State { events = selected.history.events, characters = selected.history.characters, spent = 0, stopped = true }, calls = 0, tokens = 0, tools = 0, scan = 0 };
    let stopped_child = child_controller("T", stopped, true);
    verify("stopped child never replays", stopped_child.status == 4 && stopped_child.state == stopped);
    let confirmed = completed();
    let saved = summary_controller(confirmed, "Summary", false);
    verify("summary controller preserves completed context", match saved { Ok(value) => value.answer == "Summary" && value.state.read == confirmed.state.read && value.state.edit.calls == 3 && value.state.edit.tokens == 38912, Err(_) => false });
    let refused_summary = summary_controller(confirmed, "", false);
    verify("summary failure keeps completed truth and charge", match refused_summary { Ok(_) => false, Err(failure) => confirmed.context.edit.completed && confirmed.context.edit.after == "blue\n" && failure.state.edit.calls == 3 && failure.state.edit.tokens == 38912 && failure.error != "UNEXPECTED edit aggregate" });
    let consumed = Completed { context = confirmed.context, state = WorkLedger { read = confirmed.state.read,
        edit = EditLedger { steps = 6, calls = 3, tokens = 38912, native_tokens = 163840, boundaries = 3 } } };
    verify("summary exhausted reservation precedes effect trap", match summary_controller(consumed, "Summary", true) { Ok(_) => false, Err(failure) => failure.state == consumed.state && failure.error != "UNEXPECTED edit aggregate" });
}

public flow observe(args: Array<string>) -> i32 {
    parent_groups(); remaining_groups(); return 0;
}
public flow observe_remaining(args: Array<string>) -> i32 {
    remaining_groups(); return 0;
}
