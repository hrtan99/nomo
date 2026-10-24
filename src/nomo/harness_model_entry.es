module nomo.harness_model_entry;

import std.io.println;
import nomo.cli_request.parse_args;
import nomo.harness_model_contract.fresh;
import nomo.harness_model.run as coordinate;
import nomo.harness_model.refused;

flow help() -> unit {
    println("Nomo model harness: new --once TEXT (fresh, one-shot, one depth-one child).");
    println("Main plan -> child response -> main aggregate; request/task 1..128, child 1..256, final 1..512 printable ASCII.");
    println("Plan: [\"delegate\",\"TASK\"], raw encoding <=384; each complete Prompt.data <=2048 characters.");
    println("Shared maximum 5 steps / 3 calls / 6144 token-allowance units; 2048 per attempted call, no refunds or retries.");
    println("Token allowance is not measured usage. Host aborts may leave only the last precharged STAGE marker.");
    println("No resume, line mode, real tools, persistence, concurrency or cancellation.");
}

public flow run(args: Array<string>) -> i32 {
    let request = match parse_args(args) {
        Ok(value) => value,
        Err(error) => { return refused(fresh(), error); }
    };
    if request.kind == "help" { help(); return 0; }
    if request.kind != "new" { return refused(fresh(), "resume is unavailable in the model harness"); }
    if !request.once_supplied { return refused(fresh(), "this entry requires new --once TEXT"); }
    return coordinate(request.once);
}
