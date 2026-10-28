module nomo.entry.work_chain_help;

import std.io.println;
import std.text.{len, split};
import std.collections.len as count;
import nomo.core.text.printable;
import nomo.session.edit_operation.selector_error;
import nomo.model.model_tool_contract.allowed_error;

// Literal shell arguments are data; no command is evaluated by these helpers.
public flow argument(value: string) -> Result<string, string> {
    if len(value) > 128 || !printable(value) { return Err("hint argument requires at most128 printable ASCII characters"); }
    var output = "'";
    for character in split(value, "") limit Iterations(130) {
        if character == "'" { output = output + "'\"'\"'"; }
        else { output = output + character; }
    }
    return Ok(output + "'");
}
flow bindings(id: string, workspace: string, path: string) -> Result<string, string> {
    let invalid = selector_error(id, workspace, path); if invalid != "" { return Err(invalid); }
    let identity = match argument(id) { Ok(value) => value, Err(error) => { return Err(error); } };
    let owner = match argument(workspace) { Ok(value) => value, Err(error) => { return Err(error); } };
    let file = match argument(path) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok("--id " + identity + " --workspace " + owner + " --path " + file);
}
public flow help_hint() -> unit {
    println("NEXT help (run from the project root):");
    println("./scripts/local-tryout.sh help");
}
public flow show_hint(id: string, workspace: string, path: string) -> unit {
    let selected = match bindings(id, workspace, path) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    println("NEXT inspect captured state (run from the project root with NOMO_TRYOUT_DIR set):");
    println("./scripts/local-tryout.sh show \"$NOMO_TRYOUT_DIR\" " + selected);
}
public flow continue_hint(parent: string, workspace: string, path: string, allowed: Array<string>) -> unit {
    let invalid = selector_error(parent, workspace, path);
    let files_error = allowed_error(allowed);
    if invalid != "" || files_error != "" { help_hint(); return; }
    let selected = match bindings("NEW_CHILD_ID", workspace, path) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    let identity = match argument(parent) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    var names = allowed[0]; if count(allowed) == 2 { names = names + "," + allowed[1]; }
    let files = match argument(names) { Ok(value) => value, Err(_) => { help_hint(); return; } };
    println("TEMPLATE only: replace NEW_CHILD_ID with a distinct new ID and NEW_REQUEST with your new request.");
    println("The saved parent's remaining allocation is a snapshot; it does not establish current second-slot availability. Native admission and fresh confirmation still apply.");
    println("./scripts/local-tryout.sh continue \"$NOMO_TRYOUT_DIR\" --parent " + identity + " " + selected + " --once 'NEW_REQUEST' --allow " + files);
}
public flow help(args: Array<string>) -> i32 {
    if count(args) > 1 || (count(args) == 1 && args[0] != "help" && args[0] != "--help") {
        println("REFUSED chain_help accepts no arguments or one --help."); help_hint(); return 1;
    }
    println("Nomo fixed local tryout: one newly prepared private fixture/store, one v2 lifetime, at most two currently confirmed edits.");
    println("Native ETAS entries (select work-chain for new/continue, work-chain-show for show, chain-help for help):");
    println("chain_new --id ID --workspace BIND --path FILE --once REQUEST --allow FILE[,FILE] [--cap CSV]");
    println("chain_continue --parent ROOT_ID --id NEW_CHILD_ID --workspace BIND --path FILE --once REQUEST --allow FILE[,FILE] [--cap CSV]");
    println("chain_show --id ID|--latest --workspace BIND --path FILE");
    println("chain_sessions --workspace BIND --path FILE (host: local-tryout.sh sessions DIRECTORY OPTIONS)");
    println("Latest selects the highest validated turn in this configured one-chain store. Any second slot blocks another continuation; no root fallback.");
    println("chain_help [--help]");
    println("Host launcher from the project root; export NOMO_TRYOUT_DIR to one new, unused directory before prepare:");
    println("./scripts/local-tryout.sh prepare \"$NOMO_TRYOUT_DIR\"");
    println("./scripts/local-tryout.sh new \"$NOMO_TRYOUT_DIR\" --id 'tryout-1' --workspace 'local-tryout' --path 'demo/value.txt' --once 'Replace old with the color from demo/context.txt' --allow 'demo/context.txt'");
    show_hint("tryout-1", "local-tryout", "demo/value.txt");
    println("After the new process shows a confirmed first turn, choose a distinct child ID and request; every edit needs native yes followed by Nomo y/yes on a TTY.");
    continue_hint("tryout-1", "local-tryout", "demo/value.txt", ["demo/context.txt"]);
    println("--cap has ten canonical decimal counters: steps,calls,generation,native_tokens,read_tools,scan,edit_reads,edit_read_bytes,atomic,atomic_bytes.");
    println("Default/current hard maximum:13,7,47104,196608,1,4096,3,6144,1,2048; any smaller dimension refuses a whole turn before admission/work.");
    println("Declared two-turn lifetime:26,14,94208,393216,2,8192,6,12288,2,4096. These are configured allowances, not measured Provider usage.");
    println("Requests are1..128 printable ASCII characters; read paths1..2 at most48 characters each; edit path at most128 characters/eight components; edit text at most2048 UTF-8 bytes.");
    println("Show uses captured application/journal facts only and never checks the current File. An admitted row may already have an intent/completed journal without a work snapshot.");
    println("V1, partial, denied, consumed or unknown work cannot be resumed/replayed here. Approval is current each turn; failed work is not reset, repaired or refunded.");
    println("Help/list/show need no Provider configuration. See docs/agent/LOCAL_TRYOUT_GUIDE.md for the current setup and private Model configuration.");
    return 0;
}
