module app.contract_probe;

import std.io.println;
import std.text.split;
import nomo.tools.path_policy.valid_path;
import nomo.tools.edit_proposal.{Request, propose};
import nomo.session.edit_operation.selector_error;
import nomo.model.model_tool_contract.{allowed_error, decode_reply};
import nomo.tools.edit_encoding.json;
import nomo.cli.edit_args.parse as show_args;
import nomo.cli.harness_work_args.parse as work_args;

type Check = { label: string, path: string, canonical: bool, allowed: bool };
flow slash() -> string { return std.text.from_char('\\'); }
flow checks() -> Array<Check> { return __CHECKS__; }
flow evaluate(item: Check) -> bool {
    if valid_path(item.path) != item.canonical || (selector_error("op", "owned", item.path) == "") != item.canonical ||
        (allowed_error([item.path]) == "") != item.allowed { return false; }
    let proposal = Request { path = item.path, original = "old", target = "old", replacement = "new" };
    let admitted_edit = match propose(proposal) { Ok(_) => true, Err(_) => false };
    let admitted_show = match show_args(["--id", "op", "--workspace", "owned", "--path", item.path], false) { Ok(_) => true, Err(_) => false };
    let admitted_work_edit = match work_args(["--id", "op", "--workspace", "owned", "--path", item.path, "--once", "update", "--allow", "context.txt"]) { Ok(_) => true, Err(_) => false };
    let admitted_work_read = match work_args(["--id", "op", "--workspace", "owned", "--path", "target.txt", "--once", "update", "--allow", item.path]) { Ok(_) => true, Err(_) => false };
    let action = match json(["read", item.path]) { Ok(value) => value, Err(_) => { return false; } };
    let admitted_action = match decode_reply(action, [item.path], false) { Ok(_) => true, Err(_) => false };
    return admitted_edit == item.canonical && admitted_show == item.canonical && admitted_work_edit == item.canonical &&
        admitted_work_read == item.allowed && admitted_action == item.allowed;
}
flow invariants() -> bool {
    if allowed_error([]) == "" || allowed_error(["a", "b", "c"]) == "" || allowed_error(["a", "a"]) == "" { return false; }
    if allowed_error(["__READ48_A__", "__READ48_B__"]) != "" { return false; }
    let accepted = match work_args(["--id", "op", "--workspace", "owned", "--path", "a/b/c/d/e/f/g/edit.txt", "--once", "update", "--allow", "__READ48_A__,__READ48_B__"]) { Ok(_) => true, Err(_) => false };
    let too_long = match work_args(["--id", "op", "--workspace", "owned", "--path", "edit.txt", "--once", "update", "--allow", "__READ48_A__,__READ48_B__x"]) { Ok(_) => true, Err(_) => false };
    return accepted && !too_long;
}
public flow pure_probe() -> bool {
    for item in checks() limit Iterations(64) { if !evaluate(item) { return false; } }
    return invariants();
}
public flow observe(args: Array<string>) -> i32 {
    for item in checks() limit Iterations(64) {
        if !evaluate(item) { println("FAIL " + item.label); abort("nested path contract failed"); }
        println("PASS " + item.label);
    }
    if !invariants() { abort("unchanged file count and allowance bounds failed"); }
    println("PASS unchanged_file_count_and_allowance_bounds");
    return 0;
}
