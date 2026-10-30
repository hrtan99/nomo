module app.read_tools_probe;

import std.io.println;
import std.fs.Region;
import std.text.split;
import std.collections.len as count;
import nomo.core.conversation.{Event, State};
import nomo.model.model_tool_contract.{Session, Limits, Context, LoopTurn, fresh_loop};
import nomo.agent.model_tool_controller.run_loop_controller;
import nomo.harness.legacy_string_stages.LegacyChildModel;
import nomo.tools.read_contract.{Outcome, outcome, display, ReadTools, NomoRead, NomoSearch};

type FixtureRoot;
impl FixtureRoot ~ Region;
flow slash() -> string { return split("\\/", "")[1]; }
// Two stateless implementations interpret only the explicitly admitted fixture.
public flow fixture_read_a(name: string) -> Outcome ![Error<IndexError>] ~ NomoRead<FixtureRoot> {
    if name == "fail.txt" { abort("D2_EXPECTED_BACKEND_ABORT"); }
    if name == "a.txt" || name == "b.txt" { return outcome("complete", "blue\n", 5); }
    if name == "refused.txt" { return outcome("refused", "fixture refusal", 0); }
    if name == "large.txt" { return outcome("complete", __LARGE__, 257); }
    return outcome("refused", "outside admitted fixture", 0);
}
public flow fixture_read_b(name: string) -> Outcome ![Error<IndexError>] ~ NomoRead<FixtureRoot> {
    if name == "fail.txt" { abort("D2_EXPECTED_BACKEND_ABORT"); }
    let names = ["a.txt", "b.txt", "refused.txt", "large.txt"];
    let statuses = ["complete", "complete", "refused", "complete"];
    let texts = ["blue\n", "blue\n", "fixture refusal", __LARGE__];
    let sizes: Array<usize> = [5, 5, 0, 257];
    var index: usize = 0;
    while index < count(names) limit Iterations(4) {
        if names[index] == name { return outcome(statuses[index], texts[index], sizes[index]); }
        index = index + 1;
    }
    return outcome("refused", "outside admitted fixture", 0);
}
public flow fixture_search_a(names: Array<string>, literal: string) -> Outcome ![Error<IndexError>] ~ NomoSearch<FixtureRoot> {
    if names != ["a.txt", "b.txt"] || literal != "blue" { return outcome("refused", "outside admitted fixture", 0); }
    return outcome("complete", "a.txt:1\nb.txt:1\n", 10);
}
public flow fixture_search_b(names: Array<string>, literal: string) -> Outcome ![Error<IndexError>] ~ NomoSearch<FixtureRoot> {
    if names != ["a.txt", "b.txt"] || literal != "blue" { return outcome("refused", "outside admitted fixture", 0); }
    let first = fixture_read_b(names[0]); let second = fixture_read_b(names[1]);
    return outcome("complete", names[0] + ":1\n" + names[1] + ":1\n", first.scanned + second.scanned);
}
public flow pure_contract(args: Array<string>) -> bool {
    return fixture_read_a("a.txt") == outcome("complete", "blue\n", 5) &&
        fixture_read_b("a.txt") == outcome("complete", "blue\n", 5) &&
        fixture_read_a("refused.txt") == outcome("refused", "fixture refusal", 0) &&
        fixture_read_b("refused.txt") == outcome("refused", "fixture refusal", 0) &&
        fixture_read_a("large.txt") == outcome("complete", __LARGE__, 257) &&
        fixture_read_b("large.txt") == outcome("complete", __LARGE__, 257) &&
        fixture_search_a(["a.txt", "b.txt"], "blue") == outcome("complete", "a.txt:1\nb.txt:1\n", 10) &&
        fixture_search_b(["a.txt", "b.txt"], "blue") == outcome("complete", "a.txt:1\nb.txt:1\n", 10) &&
        display(outcome("complete", "<\n\r\t", 9)) == outcome("complete", "<LT><LF><CR><TAB>", 9) &&
        display(outcome("truncated", "a\n", 123)) == outcome("truncated", "a<LF>", 123) &&
        display(outcome("complete", __RAW1024__, 1024)) == outcome("complete", __RAW1024__, 1024) &&
        display(outcome("complete", __ESCAPED_OVERFLOW__, 257)) == outcome("refused", "escaped result exceeds 1024 characters", 257);
}
flow exercise(label: string, alternate: bool, allowed: Array<string>, command: string, previous: Session,
    limits: Limits, initial: Context, completed: Context, expected: LoopTurn,
    models: usize, reads: usize, searches: usize) -> bool {
    let actual = run_loop_controller("Task", allowed, limits, previous, false, false) with {
        LegacyChildModel.infer(value) => {
            println("PORT " + label + " Model");
            if models == 0 { abort("unexpected source Model interpretation"); }
            let required = if value.final_only { completed } else { initial };
            if value != required { abort("complete source Model Context changed"); }
            let reply = if value.final_only { "[\"final\",\"Seen blue\"]" } else { command };
            resume reply;
        }
        ReadTools.read(name) => {
            println("PORT " + label + " Read");
            if reads == 0 || name != allowed[0] { abort("unexpected source read interpretation"); }
            let result = if alternate { fixture_read_b(name) } else { fixture_read_a(name) };
            resume result;
        }
        ReadTools.search(names, literal) => {
            println("PORT " + label + " Search");
            if searches == 0 || names != allowed || literal != "blue" { abort("unexpected source search interpretation"); }
            let result = if alternate { fixture_search_b(names, literal) } else { fixture_search_a(names, literal) };
            resume result;
        }
    };
    return actual == expected;
}
public flow observe(args: Array<string>) -> i32 {
    if !pure_contract(args) { abort("read result/spec fixture contract differs"); }
    println("PASS pure_result_and_two_stateless_implementations");
    __CASES__
    return 0;
}
public flow backend_abort(args: Array<string>) -> i32 {
    let limits = Limits { steps = 3, calls = 2, tokens = 4096, scan = 4096 };
    let result = run_loop_controller("Task", ["fail.txt"], limits, fresh_loop(), false, false) with {
        LegacyChildModel.infer(_) => {
            println("PORT backend_abort Model");
            resume "[\"read\",\"fail.txt\"]";
        }
        ReadTools.read(name) => {
            println("PORT backend_abort Read");
            resume fixture_read_a(name);
        }
        ReadTools.search(_, _) => { abort("unexpected search before backend abort"); }
    };
    return result.status;
}
