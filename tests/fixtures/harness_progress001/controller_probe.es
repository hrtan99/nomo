module app.harness_progress_probe;

import std.io.println;
import std.text.char_count as len;
import nomo.core.conversation.{Event, State, add, fresh as empty_history};
import nomo.model.model_tool_contract.{Session, LoopTurn};
import nomo.harness.harness_tool_contract.{Context, Ledger, Observed, fresh};
import nomo.harness.harness_model_tools.{Report, Failure, run_context, run_context_with};
import nomo.harness.legacy_string_stages.LegacyStringStages;
import nomo.model.harness_progress.HarnessProgress;

type Case = { label: string, mode: string, request: string, allowed: Array<string>, plan: string, answer: string, inspect_plan: bool, inspect_all: bool, expected: Result<Report, Failure> };
flow usage(steps: i32, calls: i32, tools: i32) -> Ledger { return Ledger { steps = steps, calls = calls, tokens = calls * 2048, tools = tools, scan = tools * 4096 }; }
flow event(role: string, kind: string, name: string, text: string) -> Event { return Event { role = role, kind = kind, name = name, text = text }; }
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
    let calls: usize = if tool { 2 } else { 1 }; let tools: usize = if tool { 1 } else { 0 };
    return LoopTurn { status = if failure { 3 } else { 0 }, state = Session {
        history = State { events = events, characters = characters, spent = if tool { 3 } else { 1 }, stopped = false },
        calls = calls, tokens = calls * 2048, tools = tools, scan = tools * 4096 } };
}
flow expected_report(answer: string) -> Report {
    return Report { request = "Q", task = "T", allowed = ["a.txt"], child = child("Q", true, false).state, status = 0,
        observed = Observed { result = "Seen blue", tool = "read", outcome = "complete: blue<LF>" }, answer = answer, ledger = usage(7, 4, 1) };
}
flow expected_failure(steps: i32, calls: i32, tools: i32, error: string, resolved: bool) -> Result<Report, Failure> {
    return Err(Failure { state = usage(steps, calls, tools), error = error, resolved = resolved });
}
flow main_reply(value: Context, item: Case) -> string {
    let expected = Context { phase = value.phase, request = "Q", task = if value.phase == "plan" { "" } else { "T" },
        result = if value.phase == "plan" { "" } else { "Seen blue" }, tool = if value.phase == "plan" { "" } else { "read" },
        outcome = if value.phase == "plan" { "" } else { "complete: blue<LF>" }, allowed = ["a.txt"] };
    if value != expected { abort("main context changed"); }
    println("PORT main " + value.phase);
    return if value.phase == "plan" { item.plan } else { item.answer };
}
flow child_reply(task: string, allowed: Array<string>, selected: State, item: Case) -> LoopTurn {
    let expected = add(empty_history(), event("user", "context", "original", "Q"));
    if task != "T" || allowed != ["a.txt"] || selected != expected { abort("child inputs changed"); }
    println("PORT child");
    return child(if item.mode == "unresolved" { "WRONG" } else { "Q" }, item.mode != "child_failure", item.mode == "child_failure");
}
flow collect(line: string) -> unit { println("COLLECT " + line); }
flow execute(item: Case, console: bool) -> Result<Report, Failure> {
    if console {
        return run_context(item.request, item.allowed, fresh(), "fixture-", false, false, item.inspect_plan, item.inspect_all) with {
            LegacyStringStages.main(value) => { resume main_reply(value, item); }
            LegacyStringStages.child(task, allowed, selected) => { resume child_reply(task, allowed, selected, item); }
        };
    }
    return run_context_with(item.request, item.allowed, fresh(), "fixture-", false, false, item.inspect_plan, item.inspect_all) with {
        LegacyStringStages.main(value) => { resume main_reply(value, item); }
        LegacyStringStages.child(task, allowed, selected) => { resume child_reply(task, allowed, selected, item); }
        HarnessProgress.write(line) => { resume collect(line); }
    };
}
flow verify(item: Case, console: bool) -> unit {
    println("CASE " + item.label + if console { " console" } else { " collector" });
    let actual = execute(item, console);
    if actual != item.expected { abort("whole Report or Failure changed"); }
    println("PASS " + item.label);
}
public flow unhandled() -> Result<Report, Failure> {
    return run_context_with("Q", ["a.txt"], fresh(), "fixture-", false, false, false, false);
}
public flow observe(args: Array<string>) -> i32 {
    __CASES__
    return 0;
}
public flow output_abort(args: Array<string>) -> i32 {
    let result = run_context_with("Q", ["a.txt"], fresh(), "fixture-", false, false, false, false) with {
        LegacyStringStages.main(_) => { abort("UNEXPECTED model after progress abort"); }
        LegacyStringStages.child(_, _, _) => { abort("UNEXPECTED child after progress abort"); }
        HarnessProgress.write(_) => { println("PORT progress abort"); abort("D12_EXPECTED_PROGRESS_ABORT"); }
    };
    println("UNREACHABLE progress abort"); return 0;
}
