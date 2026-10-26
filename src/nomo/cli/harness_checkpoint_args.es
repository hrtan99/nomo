module nomo.cli.harness_checkpoint_args;

import std.collections.len as count;
import std.text.{len, split};
import nomo.model.model_tool_contract.question_error;
import nomo.session.harness_checkpoint.{Identity, identity_error};

public type Options = { help: bool, identity: Identity, request: string };

public flow parse(args: Array<string>, saving: bool) -> Result<Options, string> {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Options { help = true, identity = Identity { id = "", workspace = "", allowed = [] }, request = "" });
    }
    let expected: usize = if saving { 8 } else { 6 };
    if count(args) != expected { return Err("expected --id ID --workspace BIND --allow FILE[,FILE] and save --once TEXT"); }
    var id = ""; var workspace = ""; var allow = ""; var request = "";
    var seen: Array<string> = [];
    var index: usize = 0;
    while index < count(args) limit Iterations(4) {
        let flag = args[index];
        for prior in seen limit Iterations(4) { if prior == flag { return Err("duplicate checkpoint option"); } }
        seen = seen.push(flag);
        let value = args[index + 1];
        if flag == "--id" { id = value; }
        else if flag == "--workspace" { workspace = value; }
        else if flag == "--allow" { if len(value) > 97 { return Err("raw allowlist exceeds 97 characters"); } allow = value; }
        else if flag == "--once" && saving { request = value; }
        else { return Err("unknown checkpoint option"); }
        index = index + 2;
    }
    let identity = Identity { id = id, workspace = workspace, allowed = split(allow, ",") };
    let invalid = identity_error(identity); if invalid != "" { return Err(invalid); }
    if saving { let invalid_request = question_error(request); if invalid_request != "" { return Err(invalid_request); } }
    return Ok(Options { help = false, identity = identity, request = request });
}
