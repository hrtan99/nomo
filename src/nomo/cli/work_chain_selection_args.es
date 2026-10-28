module nomo.cli.work_chain_selection_args;

import std.collections.len as count;
import nomo.session.edit_operation.selector_error;
import nomo.session.work_chain_selection.Selector;

public enum Command { Sessions, Show }
public type Input = { help: bool, selector: Selector, workspace: string, path: string };
public flow parse(args: Array<string>, command: Command) -> Result<Input, string> {
    let listing = match command { Command.Sessions => true, Command.Show => false };
    if count(args) == 1 && (args[0] == "help" || args[0] == "--help") {
        return Ok(Input { help = true, selector = Selector.All, workspace = "", path = "" });
    }
    if count(args) < 4 || count(args) > 6 { return Err("expected bounded workspace/path and one --id or --latest selector"); }
    var id = ""; var workspace = ""; var path = ""; var latest = false; var supplied_id = false;
    var seen: Array<string> = []; var index: usize = 0;
    while index < count(args) limit Iterations(4) {
        let flag = args[index];
        for previous in seen limit Iterations(4) { if previous == flag { return Err("duplicate discovery selector"); } }
        seen = seen.push(flag); index = index + 1;
        if flag == "--latest" {
            if listing { return Err("sessions lists both fixed slots; no latest selector"); }
            latest = true;
        } else {
            if index >= count(args) { return Err("discovery selector value missing"); }
            let value = args[index]; index = index + 1;
            match flag {
                "--workspace" => { workspace = value; }
                "--path" => { path = value; }
                "--id" => { if listing { return Err("sessions lists both fixed slots; no ID selector"); } id = value; supplied_id = true; }
                _ => { return Err("unknown discovery selector"); }
            }
        }
    }
    if !listing && latest == supplied_id { return Err("show requires exactly one --id or --latest"); }
    let invalid = selector_error(if supplied_id { id } else { "discovery" }, workspace, path); if invalid != "" { return Err(invalid); }
    var selector: Selector = Selector.Exact(id);
    if latest { selector = Selector.Latest; }
    if listing { selector = Selector.All; }
    return Ok(Input { help = false, selector = selector, workspace = workspace, path = path });
}
