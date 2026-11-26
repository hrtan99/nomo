module nomo.adapters.cli.arguments.harness_edit_args;

import std.collections.len as count;
import nomo.domain.sessions.edit_operation.selector_error;
import nomo.domain.harness.harness_edit_contract.text_error;

public type Input = { help: bool, id: string, workspace: string, path: string, request: string };

public flow parse(args: Array<string>) -> Result<Input, string> {
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Input { help = true, id = "", workspace = "", path = "", request = "" });
    }
    if count(args) != 8 { return Err("expected --id ID --workspace BIND --path FILE --once TASK"); }
    var id = ""; var workspace = ""; var path = ""; var request = "";
    var seen: Array<string> = []; var index: usize = 0;
    @limits([Iterations(4)]) while index < count(args) {
        let flag = args[index];
        @limits([Iterations(4)]) for previous in seen { if flag == previous { return Err("duplicate harness edit option"); } }
        seen = seen.push(flag); let value = args[index + 1];
        match flag {
            "--id" => { id = value; }
            "--workspace" => { workspace = value; }
            "--path" => { path = value; }
            "--once" => { request = value; }
            _ => { return Err("unknown harness edit option"); }
        }
        index = index + 2;
    }
    let selected = selector_error(id, workspace, path); if selected != "" { return Err(selected); }
    let invalid = text_error(request, "edit task"); if invalid != "" { return Err(invalid); }
    return Ok(Input { help = false, id, workspace, path, request });
}
