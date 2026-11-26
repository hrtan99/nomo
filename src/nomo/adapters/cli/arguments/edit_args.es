module nomo.adapters.cli.arguments.edit_args;

import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.mutations.edit_proposal.text_bytes;

public type Options = { help: bool, id: string, workspace: string, path: string, target: string, replacement: string };

public flow parse(args: Array<string>, applying: bool) -> Result<Options, string> {
    if args.len() == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Options { help = true, id = "", workspace = "", path = "", target = "", replacement = "" });
    }
    let expected: usize = if applying { 10 } else { 6 };
    if args.len() != expected { return Err("expected --id ID --workspace BIND --path FILE and apply --target TEXT --replacement TEXT"); }
    var id = ""; var workspace = ""; var path = ""; var target = ""; var replacement = "";
    var seen: Array<string> = []; var index: usize = 0;
    @limits([Iterations(5)]) while index < args.len() {
        let flag = args[index];
        @limits([Iterations(5)]) for previous in seen { if flag == previous { return Err("duplicate edit option"); } }
        seen = seen.push(flag); let value = args[index + 1];
        match flag {
            "--id" => { id = value; }
            "--workspace" => { workspace = value; }
            "--path" => { path = value; }
            "--target" => { if !applying { return Err("unknown edit option"); } target = value; }
            "--replacement" => { if !applying { return Err("unknown edit option"); } replacement = value; }
            _ => { return Err("unknown edit option"); }
        }
        index = index + 2;
    }
    let invalid = selector_error(id, workspace, path); if invalid != "" { return Err(invalid); }
    if applying {
        let size = match text_bytes(target, "target") { Ok(value) => value, Err(error) => { return Err(error); } };
        match text_bytes(replacement, "replacement") { Ok(_) => (), Err(error) => { return Err(error); } }
        if size == 0 { return Err("target must not be empty"); }
    }
    return Ok(Options { help = false, id, workspace, path, target, replacement });
}
