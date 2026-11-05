module app.contract_probe;

import std.io.println;
import std.text.{contains, char_count as len, split};
import nomo.core.text.printable;
import nomo.harness.harness_model_contract.{decode_plan, decode_read_plan};
import nomo.harness.model_plan_diagnostic.returned_text;

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow accepted(raw: string, expected: string) -> bool {
    return match decode_read_plan(raw) { Ok(actual) => actual == expected, Err(_) => false };
}
flow refused(raw: string) -> bool {
    return match decode_read_plan(raw) { Ok(_) => false, Err(_) => true };
}
flow diagnosed(raw: string, expected: string) -> bool {
    return match decode_read_plan(raw) { Ok(_) => false, Err(actual) => actual == expected };
}
flow legacy(raw: string, expected: string, allowed: bool) -> bool {
    return match decode_plan(raw) { Ok(actual) => allowed && actual == expected, Err(_) => !allowed };
}
flow exact_snippet(raw: string, excluded: string, expected: string) -> bool {
    return returned_text(raw, excluded) == expected;
}
flow snippet(raw: string, excluded: string, required: Array<string>, forbidden: Array<string>) -> bool {
    let actual = returned_text(raw, excluded);
    if !printable(actual) || len(actual) > 384 { return false; }
    for value in required limit Iterations(16) { if !contains(actual, value) { return false; } }
    for value in forbidden limit Iterations(16) { if contains(actual, value) { return false; } }
    return true;
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !item.passed { println("FAIL " + item.label); abort("model protocol semantic contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
