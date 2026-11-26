module nomo.adapters.cli.legacy.harness_model_tools_entry;

import std.io.println;
import nomo.domain.text.read_text.within;
import std.text.{char_count as len, split};
import nomo.adapters.cli.arguments.cli_request.parse_args;
import nomo.domain.harness.harness_tool_contract.fresh;
import nomo.adapters.model.harness.harness_model_tools.{run as coordinate, refused};

flow help() -> unit {
    println("Nomo model/tool harness: new --once TEXT --allow FILE[,FILE] (either flag order).");
    println("Raw request/task 1..128, child 1..256, final 1..512 printable ASCII; 1..2 paths of <=48 characters, raw allowlist <=97.");
    println("Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 4096 scan allowance; not measured usage.");
    println("Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.");
}

public type AllowArgs = { remaining: Array<string>, supplied: bool, allowed: string };
public flow extract_allow(args: Array<string>, unicode: bool) -> Result<AllowArgs, string> {
    if args.len() == 0 || args.len() > 7 { return Err("expected bounded model/tool arguments"); }
    var remaining: Array<string> = [args[0]];
    var supplied = false;
    var allowed = "";
    var index: usize = 1;
    @limits([Iterations(7)]) while index < args.len() {
        let flag = args[index];
        if flag == "--allow" {
            if supplied || index + 1 >= args.len() { return Err(if unicode { "expected exactly one --allow FILE[,FILE...]" } else { "expected exactly one --allow FILE[,FILE]" }); }
            allowed = args[index + 1];
            if unicode && !within(allowed, 195) { return Err("raw allowlist exceeds 195 UTF-8 bytes"); }
            if !unicode && len(allowed) > 97 { return Err("raw allowlist exceeds 97 characters"); }
            supplied = true;
            index = index + 2;
        } else {
            remaining = remaining.push(flag);
            index = index + 1;
            if (flag == "--once" || flag == "--id") && index < args.len() {
                remaining = remaining.push(args[index]); index = index + 1;
            }
        }
    }
    return Ok(AllowArgs { remaining, supplied, allowed });
}

public flow run(args: Array<string>) -> i32 {
    if args.len() == 0 || args.len() > 7 { return refused(fresh(), "expected bounded new --once TEXT --allow FILE[,FILE]"); }
    let extracted = match extract_allow(args, false) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    let request = match parse_args(extracted.remaining) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if request.kind == "help" { if extracted.supplied { return refused(fresh(), "help must be used alone"); } help(); return 0; }
    if request.kind != "new" { return refused(fresh(), "resume is unavailable in the model/tool harness"); }
    if !request.once_supplied { return refused(fresh(), "this entry requires new --once TEXT"); }
    if !extracted.supplied { return refused(fresh(), "this entry requires --allow FILE[,FILE]"); }
    return coordinate(request.once, split(extracted.allowed, ","));
}
