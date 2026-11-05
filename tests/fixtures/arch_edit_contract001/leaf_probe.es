module app.contract_probe;

import std.io.println;
import std.text.split;
import nomo.tools.edit_contract.{Prepared, prepare_original};
import nomo.tools.edit_proposal.{Request, Proposal};

type Check = { label: string, passed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow prepared(name: string, before: string, target: string, replacement: string, after: string) -> bool {
    let expected = Prepared { request = Request { path = name, original = before, target = target, replacement = replacement },
        proposal = Proposal { path = name, before = before, after = after } };
    return match prepare_original(name, before, target, replacement) { Ok(value) => value == expected, Err(_) => false };
}
flow refused(name: string, before: string, target: string, replacement: string, error: string) -> bool {
    return match prepare_original(name, before, target, replacement) { Ok(_) => false, Err(value) => value == error };
}
flow checks() -> Array<Check> { return __CHECKS__; }
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(16) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(16) {
        if !item.passed { println("FAIL " + item.label); abort("edit contract leaf check failed"); }
        println("PASS " + item.label);
    }
    return 0;
}
