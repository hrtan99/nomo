module nomo.adapters.cli.native.options;

import std.text.{split_once, strip_prefix};
import nomo.domain.conversation.start.SessionSelection;

public type Options = { workspace: string, selection: SessionSelection, once: Option<string>,
    open_project: Option<string>, projects: bool, sessions: bool, all_sessions: bool,
    history: bool, status: bool, title: Option<string>, import_path: Option<string>,
    export_path: Option<string>, check: Option<Array<string>> };

public flow offline(options: Options) -> bool {
    return options.projects || options.sessions || options.history || options.status ||
        match options.export_path { Some(_) => true, None() => false };
}

public flow parse(args: Array<string>) -> Options ![Error<IndexError>, Error<BudgetExceeded>] {
    var workspace = "";
    var selection = SessionSelection.Current;
    var once: Option<string> = None();
    var open_project: Option<string> = None();
    var projects = false; var sessions = false; var all_sessions = false;
    var history = false; var status = false;
    var title: Option<string> = None();
    var import_path: Option<string> = None(); var export_path: Option<string> = None();
    var check: Option<Array<string>> = None();
    var index: usize = 0;
    @limits([Iterations(2147483647)]) while index < args.len() {
        let (option, inline) = match split_once(args[index], "=") { Some((name, value)) => (name, Some(value)), None() => (args[index], None()) };
        index = index + 1;
        if option == "--new" { selection = SessionSelection.Fresh; continue; }
        if option == "--latest" { selection = SessionSelection.Existing; continue; }
        if option == "--projects" { projects = true; continue; }
        if option == "--sessions" { sessions = true; continue; }
        if option == "--all" { all_sessions = true; continue; }
        if option == "--history" || option == "--events" { history = true; continue; }
        if option == "--status" { status = true; continue; }
        if option == "--high-input" { continue; }
        if option == "--check" {
            var command: Array<string> = match inline { Some(value) => [value], None() => [] };
            @limits([Iterations(2147483647)]) while index < args.len() { command = command.push(args[index]); index = index + 1; }
            if command.len() == 0 { abort("--check requires a command"); }
            check = Some(command); continue;
        }
        if option == "--resume" || option == "--open" {
            var selected = match inline { Some(value) => value, None() => "" };
            if selected == "" && index < args.len() {
                let value_follows = match strip_prefix(args[index], "--") { Some(_) => false, None() => true };
                if value_follows {
                    selected = args[index]; index = index + 1;
                }
            }
            if option == "--open" { open_project = Some(selected); }
            else { selection = if selected == "" { SessionSelection.Choose } else { SessionSelection.Exact(selected) }; }
            continue;
        }
        let value = match inline {
            Some(value) => value,
            None() => { if index >= args.len() { abort("native option requires a value: " + option); } let value = args[index]; index = index + 1; value }
        };
        if option == "--workspace" || option == "--root" { workspace = value; }
        else if option == "--id" { selection = SessionSelection.Exact(value); }
        else if option == "--once" { once = Some(value); }
        else if option == "--title" { title = Some(value); }
        else if option == "--import" { import_path = Some(value); }
        else if option == "--export" { export_path = Some(value); }
        else { abort("unknown native entry option: " + option); }
    }
    if workspace == "" { abort("provide --workspace with the folder mounted as /project"); }
    return Options { workspace, selection, once, open_project,
        projects, sessions, all_sessions, history, status,
        title, import_path, export_path, check };
}
