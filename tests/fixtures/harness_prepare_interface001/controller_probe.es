module app.prepare_interface_probe;

import std.io.println;
import std.text.char_count as len;
import nomo.core.conversation.{Event, State, add, fresh as empty_history};
import nomo.model.model_tool_contract.{Session, LoopTurn};
import nomo.cli.harness_edit_args.Input;
import nomo.cli.harness_work_args.Work;
import nomo.harness.harness_tool_contract.{Context as ReadContext, Ledger as ReadLedger};
import nomo.harness.harness_edit_contract.{Context as EditContext, Ledger as EditLedger};
import nomo.harness.harness_work_contract.{Context as WorkContext, Evidence, Ledger};
import nomo.harness.legacy_string_stages.{LegacyStringStages, LegacyEditStages};
import nomo.harness.edit_original.EditOriginal;
import nomo.entry.harness_work_entry.{prepare_with, Pending, Failure};
import nomo.tools.edit_contract.{Selector, Prepared};
import nomo.tools.edit_proposal.{Request, Proposal};

flow event(role: string, kind: string, name: string, text: string) -> Event {
    return Event { role = role, kind = kind, name = name, text = text };
}
flow child(original: string) -> LoopTurn {
    let events = [event("user", "context", "original", original), event("user", "input", "", "T"),
        event("model", "text", "qwen", ""), event("model", "request", "read", "[\"read\",\"a.txt\"]"),
        event("tool", "complete", "read", "complete: blue<LF>"), event("model", "text", "qwen", ""),
        event("assistant", "final", "", "Seen blue")];
    var characters: usize = 0;
    for item in events limit Iterations(7) { characters = characters + len(item.name) + len(item.text); }
    return LoopTurn { status = 0, state = Session { history = State { events = events, characters = characters, spent = 3, stopped = false },
        calls = 2, tokens = 4096, tools = 1, scan = 4096 } };
}
flow read_ledger() -> ReadLedger { return ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 }; }
flow edit_ledger(steps: i32, calls: i32, tokens: i32, native: i32, boundaries: i32) -> EditLedger {
    return EditLedger { steps = steps, calls = calls, tokens = tokens, native_tokens = native, boundaries = boundaries };
}
flow evidence() -> Evidence {
    return Evidence { request = "Q", task = "T", operation = "read", files = ["a.txt"], literal = "",
        outcome = "complete: blue<LF>", result = "Seen blue", summary = "Answer", allowed = ["a.txt"], ledger = read_ledger() };
}
flow input() -> Work {
    return Work { edit = Input { help = false, id = "fixture", workspace = "synthetic", path = "dir/file.txt", request = "Q" }, allowed = ["a.txt"] };
}
flow edit_context(phase: string, task: string) -> WorkContext {
    let edit = EditContext { phase = phase, request = "Q", task = task, id = "fixture", workspace = "synthetic", path = "dir/file.txt",
        before = "old\n", after = "", request_digest = "", before_digest = "", after_digest = "", before_bytes = 4, after_bytes = 0, completed = false };
    return WorkContext { edit = edit, evidence = evidence() };
}
flow expected_pending() -> Pending {
    let selected = Selector { id = "fixture", workspace = "synthetic", path = "dir/file.txt" };
    let prepared = Prepared { request = Request { path = "dir/file.txt", original = "old\n", target = "old", replacement = "blue" },
        proposal = Proposal { path = "dir/file.txt", before = "old\n", after = "blue\n" } };
    return Pending { selected = selected, prepared = prepared, evidence = evidence(), request = "Q", task = "edit T",
        state = Ledger { read = read_ledger(), edit = edit_ledger(4, 2, 36864, 98304, 2) }, high_input = false };
}
flow run_case(label: string, mode: string, chain: bool) -> Result<Pending, Failure> {
    let original = (value: string) => if mode == "mismatch" && value != "confirmed-parent" { "current original differs from confirmed parent result" } else { "" };
    let log = (name: string, state: Ledger) => {
        if state.read != read_ledger() { abort("read ledger changed before edit stage"); }
        let expected = if name == "edit-plan" { edit_ledger(1, 1, 4096, 32768, 0) } else { edit_ledger(3, 2, 36864, 98304, 1) };
        if state.edit != expected { abort("edit stage was not precharged"); }
        println("PORT " + label + " stage " + name);
    };
    return prepare_with(input(), original, log, chain, false, false) with {
        LegacyStringStages.main(value) => {
            let expected = ReadContext { phase = value.phase, request = "Q", task = if value.phase == "plan" { "" } else { "T" },
                result = if value.phase == "plan" { "" } else { "Seen blue" }, tool = if value.phase == "plan" { "" } else { "read" },
                outcome = if value.phase == "plan" { "" } else { "complete: blue<LF>" }, allowed = ["a.txt"] };
            if value != expected { abort("read main context changed"); }
            println("PORT " + label + " read-main " + value.phase);
            let answer = if value.phase == "plan" { if mode == "bad_plan" { "broken" } else { "[\"delegate\",\"T\"]" } } else { "Answer" };
            resume answer;
        }
        LegacyStringStages.child(task, allowed, selected) => {
            let expected = add(empty_history(), event("user", "context", "original", "Q"));
            if task != "T" || allowed != ["a.txt"] || selected != expected { abort("read child inputs changed"); }
            println("PORT " + label + " read-child");
            resume child(if mode == "bad_child" { "WRONG" } else { "Q" });
        }
        EditOriginal.read(path) => {
            if path != "dir/file.txt" { abort("original path changed"); }
            println("PORT " + label + " read-original " + path);
            if mode == "abort" { abort("D9_EXPECTED_READ_ABORT"); }
            let answer: Result<string, string> = if mode == "read_error" { Err("synthetic read refused") } else { Ok("old\n") };
            resume answer;
        }
        LegacyEditStages.plan(value) => {
            if value != edit_context("plan", "") { abort("edit plan context changed"); }
            println("PORT " + label + " edit-plan"); resume "[\"delegate\",\"edit T\"]";
        }
        LegacyEditStages.child(value) => {
            if value != edit_context("child", "edit T") { abort("edit child context changed"); }
            println("PORT " + label + " edit-child"); resume "[\"edit\",\"old\",\"blue\"]";
        }
        LegacyEditStages.aggregate(_) => { abort("unexpected edit aggregate"); }
    };
}
flow verify(label: string, mode: string, chain: bool, expected: string, read: ReadLedger, edit: EditLedger) -> unit {
    let result = run_case(label, mode, chain);
    let passed = match result {
        Ok(value) => expected == "" && value == expected_pending(),
        Err(failure) => expected != "" && failure.error == expected && failure.state == Ledger { read = read, edit = edit },
    };
    if !passed { println("FAIL " + label); abort("prepare interface case failed"); }
    println("PASS " + label);
}
public flow controller_unhandled() -> Result<Pending, Failure> {
    let original = (value: string) => ""; let log = (name: string, state: Ledger) => {};
    return prepare_with(input(), original, log, false, false, false);
}
public flow observe(args: Array<string>) -> i32 {
    let zero = edit_ledger(0, 0, 0, 0, 0); let initial = ReadLedger { steps = 1, calls = 1, tokens = 2048, tools = 0, scan = 0 };
    let unresolved = ReadLedger { steps = 2, calls = 1, tokens = 2048, tools = 0, scan = 0 };
    verify("legacy", "ok", false, "", read_ledger(), zero);
    verify("chain", "ok", true, "", read_ledger(), zero);
    verify("read_error", "read_error", false, "synthetic read refused", read_ledger(), zero);
    verify("mismatch", "mismatch", true, "current original differs from confirmed parent result", read_ledger(), zero);
    verify("bad_plan", "bad_plan", false, "expected bounded flat single-line delegation JSON", initial, zero);
    verify("bad_child", "bad_child", false, "child original request or task history changed", unresolved, zero);
    return 0;
}
public flow abort_probe(args: Array<string>) -> i32 {
    let value = run_case("abort", "abort", false); println("UNREACHABLE"); return 0;
}
