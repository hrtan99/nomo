module nomo.adapters.cli.arguments.harness_successor_args;

import std.text.{char_count as len, split};
import nomo.domain.harness.model_tool_contract.question_error;
import nomo.session.harness_checkpoint.Identity;
import nomo.domain.sessions.harness_checkpoint.identity_error;

public type Options = { help: bool, predecessor: Identity, successor: Identity, request: string };

public flow parse(args: Array<string>, continuing: bool) -> Result<Options, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        let blank = Identity { id = "", workspace = "", allowed = [] };
        return Ok(Options { help = true, predecessor = blank, successor = blank, request = "" });
    }
    let expected: usize = if continuing { 10 } else { 8 };
    if args.len() != expected { return Err("expected --id OLD --successor NEW --workspace BIND --allow FILE[,FILE] and continue --once TEXT"); }
    var id = ""; var next = ""; var workspace = ""; var allow = ""; var request = "";
    var seen: Array<string> = []; var index: usize = 0;
    @limits([Iterations(5)]) while index < args.len() {
        let flag = args[index];
        if seen.iter().any(previous => previous == flag) { return Err("duplicate successor option"); }
        seen = seen.push(flag);
        let value = args[index + 1];
        if flag == "--id" { id = value; }
        else if flag == "--successor" { next = value; }
        else if flag == "--workspace" { workspace = value; }
        else if flag == "--allow" { if len(value) > 97 { return Err("raw allowlist exceeds 97 characters"); } allow = value; }
        else if flag == "--once" && continuing { request = value; }
        else { return Err("unknown successor option"); }
        index = index + 2;
    }
    let predecessor = Identity { id, workspace, allowed = split(allow, ",") };
    let successor = Identity { id = next, workspace, allowed = predecessor.allowed };
    let invalid = identity_error(predecessor); if invalid != "" { return Err(invalid); }
    let invalid_next = identity_error(successor); if invalid_next != "" { return Err(invalid_next); }
    if id == next { return Err("successor must have a distinct checkpoint ID"); }
    if continuing { let invalid_request = question_error(request); if invalid_request != "" { return Err(invalid_request); } }
    return Ok(Options { help = false, predecessor, successor, request });
}
