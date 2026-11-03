module nomo.entry.read_model_tools_entry;

import std.io.println;
import std.collections.len as count;
import std.text.{len, split};
import nomo.cli.read_cli.parse_args;
import nomo.harness.read_tool_contract.fresh;
import nomo.harness.read_model_tools.run as coordinate;
import nomo.harness.read_model_tools.refused;

flow help() -> unit {
    println("Nomo model/tool harness: new --once TEXT --allow FILE[,FILE...] (either flag order).");
    println("Raw request/task 1..128, child 1..256, final 1..512 safe UTF-8 bytes; 1..4 paths of <=48 characters, raw allowlist <=195.");
    println("Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 16384 scan allowance; not measured usage.");
    println("Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.");
}

public flow run(args: Array<string>) -> i32 {
    if count(args) == 0 || count(args) > 7 { return refused(fresh(), "expected bounded new --once TEXT --allow FILE[,FILE...]"); }
    var remaining: Array<string> = [args[0]];
    var supplied = false;
    var allowed = "";
    var index: usize = 1;
    while index < count(args) limit Iterations(7) {
        let flag = args[index];
        if flag == "--allow" {
            if supplied || index + 1 >= count(args) { return refused(fresh(), "expected exactly one --allow FILE[,FILE...]"); }
            allowed = args[index + 1];
            if len(allowed) > 195 { return refused(fresh(), "raw allowlist exceeds 195 characters"); }
            supplied = true;
            index = index + 2;
        } else {
            remaining = remaining.push(flag);
            index = index + 1;
            if (flag == "--once" || flag == "--id") && index < count(args) {
                remaining = remaining.push(args[index]); index = index + 1;
            }
        }
    }
    let request = match parse_args(remaining) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if request.kind == "help" { if supplied { return refused(fresh(), "help must be used alone"); } help(); return 0; }
    if request.kind != "new" { return refused(fresh(), "resume is unavailable in the model/tool harness"); }
    if !request.once_supplied { return refused(fresh(), "this entry requires new --once TEXT"); }
    if !supplied { return refused(fresh(), "this entry requires --allow FILE[,FILE...]"); }
    return coordinate(request.once, split(allowed, ","));
}
