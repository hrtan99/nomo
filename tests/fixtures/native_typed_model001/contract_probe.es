module app.contract_probe;

import std.io.println;
import std.text.split;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import nomo.tools.edit_contribution.{Contribution, project};
import nomo.harness.typed_edit_contract.project_context;
import nomo.harness.harness_work_contract.{Context, Evidence};
import nomo.harness.harness_edit_contract.Context as EditContext;
import nomo.harness.harness_tool_contract.Ledger as ReadLedger;

type Check = { label: string, passed: bool };
flow slash() -> string { return split("\\/", "")[1]; }
flow checks() -> Array<Check> { return __CHECKS__; }

flow projected(path: string, original: string, target: string, replacement: string, expected: string, error: string) -> bool {
    let contribution = Contribution { target = target, replacement = replacement };
    return match project(path, original, contribution) {
        Ok(value) => error == "" && value.path == path && value.before == original && value.after == expected,
        Err(value) => error != "" && value == error,
    };
}

flow context(before: string, path: string, phase: string, changed_request: bool) -> Context {
    let request = "Change selected text using read evidence";
    let edit = EditContext { phase = phase, request = request, task = "Replace the selected literal", id = "typed-op", workspace = "owned", path = path,
        before = before, after = "", request_digest = "", before_digest = "", after_digest = "",
        before_bytes = byte_count(utf8_encode(before)), after_bytes = 0, completed = false };
    let evidence = Evidence { request = if changed_request { "Different request" } else { request }, task = "Read context.txt", operation = "read", files = ["context.txt"], literal = "",
        outcome = "complete: supporting text", result = "Supporting text.", summary = "Use observed context.", allowed = ["context.txt"],
        ledger = ReadLedger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    return Context { edit = edit, evidence = evidence };
}
flow contextual(before: string, target: string, replacement: string, phase: string, changed_request: bool, expected: string, accepted: bool) -> bool {
    let supplied = context(before, "notes/report.txt", phase, changed_request);
    let contribution = Contribution { target = target, replacement = replacement };
    let result = project_context(supplied, contribution);
    return match result {
        Ok(value) => accepted && value.path == supplied.edit.path && value.before == before && value.after == expected,
        Err(_) => !accepted,
    };
}

public flow pure_probe() -> bool {
    for item in checks() limit Iterations(32) { if !item.passed { return false; } }
    return true;
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(32) {
        if !item.passed { println("FAIL " + item.label); abort("typed contribution pure contract software bug"); }
        println("PASS " + item.label);
    }
    return 0;
}
