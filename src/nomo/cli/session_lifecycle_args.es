module nomo.cli.session_lifecycle_args;

import std.collections.len as count;
import nomo.session.harness_checkpoint.Identity;
import nomo.cli.harness_checkpoint_args.parse as checkpoint;
import nomo.cli.harness_successor_args.parse as successor;

public type Request = { help: bool, predecessor: Identity, successor: Identity, request: string, successor_show: bool };

public flow help_lines() -> Array<string> {
    return ["Nomo sessions: init -> new -> resume -> show.",
        "Run: etas run PROJECT --flow COMMAND --allow-effects --args OPTIONS. Commands select their existing profiles.",
        "init: --id ID --workspace BIND --allow FILE[,FILE]",
        "new: --id ID --workspace BIND --allow FILE[,FILE] --once TEXT",
        "resume: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE] --once TEXT",
        "show first: --id FIRST --workspace BIND --allow FILE[,FILE]",
        "show successor: --id FIRST --successor SECOND --workspace BIND --allow FILE[,FILE]",
        "Help: use --flow help [--args COMMAND], or pass help/--help alone after --args for any command.",
        "Initialize one fresh private project-owned store. Keep IDs, workspace label and ordered allowed files explicit.",
        "Each first checkpoint admits at most one second turn; successors allow show only. No latest selection or third turn.",
        "Failed, pending or unknown work is not completed. Admission may be consumed; do not retry automatically.",
        "Show reads saved data with no model/File configuration, tool replay or Memory mutation.",
        "NEXT arrays contain a --flow entry followed by literal --args values; replace placeholders.",
        "Bounds: IDs/workspace and request at most 128 printable ASCII characters; allow one/two files of at most 48 characters, at most 97 raw characters."];
}

public flow topic_lines(topic: string) -> Array<string> {
    let lines = help_lines();
    return match topic {
        "" => lines,
        "init" => [lines[2], lines[8], lines[13], lines[12]],
        "new" => [lines[3], lines[9], lines[10], lines[13], lines[12]],
        "resume" => [lines[4], lines[9], lines[10], lines[13], lines[12]],
        "show" => [lines[5], lines[6], lines[11], lines[13], lines[12]],
        _ => ["Unsupported session help topic; use init, new, resume or show."],
    };
}

flow helping(topic: string) -> Request {
    let blank = Identity { id = "", workspace = "", allowed = [] };
    return Request { help = true, predecessor = blank, successor = blank, request = topic, successor_show = false };
}

flow first(args: Array<string>, saving: bool) -> Result<Request, string> {
    let options = match checkpoint(args, saving) { Ok(value) => value, Err(error) => { return Err(error); } };
    let blank = Identity { id = "", workspace = "", allowed = [] };
    return Ok(Request { help = false, predecessor = options.identity, successor = blank,
        request = options.request, successor_show = false });
}

flow following(args: Array<string>, continuing: bool) -> Result<Request, string> {
    let options = match successor(args, continuing) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Request { help = false, predecessor = options.predecessor, successor = options.successor,
        request = options.request, successor_show = !continuing });
}

// Command selection belongs to separate native entries. Only show selects a
// first/successor data format; literal argument values never select a command.
public flow parse(action: string, args: Array<string>) -> Result<Request, string> {
    match action { "init" => {}, "new" => {}, "resume" => {}, "show" => {}, "help" => {},
        _ => { return Err("unsupported session action; use init, new, resume, show or help"); } }
    let help = count(args) == 1 && (args[0] == "help" || args[0] == "--help");
    if help || (action == "help" && count(args) == 0) {
        return Ok(helping(""));
    }
    return match action {
        "init" => first(args, false),
        "new" => first(args, true),
        "resume" => following(args, true),
        "show" => { if count(args) == 8 { return following(args, false); } return first(args, false); },
        "help" => {
            if count(args) != 1 { return Err("session help accepts no selectors"); }
            let topic = args[0];
            return match topic { "init" => Ok(helping(topic)), "new" => Ok(helping(topic)),
                "resume" => Ok(helping(topic)), "show" => Ok(helping(topic)),
                _ => Err("unsupported session help topic; use init, new, resume or show") };
        }
        _ => Err("unsupported session action; use init, new, resume, show or help"),
    };
}
