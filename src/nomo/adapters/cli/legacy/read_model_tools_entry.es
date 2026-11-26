module nomo.adapters.cli.legacy.read_model_tools_entry;

import nomo.adapters.cli.legacy.harness_model_tools_entry.extract_allow;
import std.io.println;
import std.text.split;
import nomo.adapters.cli.arguments.read_cli.parse_args;
import nomo.domain.harness.harness_tool_contract.fresh;
import nomo.adapters.model.harness.read_model_tools.{run as coordinate, refused};

flow help() -> unit {
    println("Nomo model/tool harness: new --once TEXT --allow FILE[,FILE...] (either flag order).");
    println("Raw request/task 1..65536, child 1..1048576, final 1..1048576 safe UTF-8 bytes; 1..4 paths of <=128 UTF-8 bytes, raw allowlist <=195 bytes.");
    println("Shared maximum: 7 steps / 4 model calls / 8192 token allowance / 1 read-or-search / 16384 scan allowance; not measured usage.");
    println("Complete model context <=2048. Read size checked after reading. One fresh serial child; no writes, commands, resume, line mode or persistence. Host aborts may leave reservations unresolved.");
}

public flow run(args: Array<string>) -> i32 {
    if args.len() == 0 || args.len() > 7 { return refused(fresh(), "expected bounded new --once TEXT --allow FILE[,FILE...]"); }
    let extracted = match extract_allow(args, true) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    let request = match parse_args(extracted.remaining) { Ok(value) => value, Err(error) => { return refused(fresh(), error); } };
    if request.kind == "help" { if extracted.supplied { return refused(fresh(), "help must be used alone"); } help(); return 0; }
    if request.kind != "new" { return refused(fresh(), "resume is unavailable in the model/tool harness"); }
    if !request.once_supplied { return refused(fresh(), "this entry requires new --once TEXT"); }
    if !extracted.supplied { return refused(fresh(), "this entry requires --allow FILE[,FILE...]"); }
    return coordinate(request.once, split(extracted.allowed, ","));
}
