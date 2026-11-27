module nomo.domain.conversation.start;

public enum SessionSelection { Current, Fresh, Existing, Exact(string), Choose }
public enum EntryMode { Interactive, Attach }

public type Options = { workspace: string, selection: SessionSelection, once: Option<string>,
    open_project: Option<string>, projects: bool, sessions: bool, all_sessions: bool,
    history: bool, status: bool, title: Option<string>, import_path: Option<string>,
    export_path: Option<string>, check: Option<Array<string>> };

public flow offline(options: Options) -> bool {
    return options.projects || options.sessions || options.history || options.status ||
        match options.export_path { Some(_) => true, None() => false };
}

// The application resolves the project/session; transport forwards this argv verbatim.
public flow forwarded(options: Options, selection: SessionSelection) -> Array<string> {
    var arguments: Array<string> = match selection {
        SessionSelection.Current => [], SessionSelection.Fresh => ["--new"],
        SessionSelection.Existing => ["--latest"], SessionSelection.Exact(id) => ["--id", id],
        SessionSelection.Choose => ["--resume"],
    };
    if options.projects { arguments = arguments.push("--projects"); }
    if options.sessions { arguments = arguments.push("--sessions"); }
    if options.all_sessions { arguments = arguments.push("--all"); }
    if options.history { arguments = arguments.push("--history"); }
    if options.status { arguments = arguments.push("--status"); }
    match options.title { Some(value) => { arguments = arguments.extend(["--title", value]); } None() => (), }
    match options.import_path { Some(value) => { arguments = arguments.extend(["--import", value]); } None() => (), }
    match options.export_path { Some(value) => { arguments = arguments.extend(["--export", value]); } None() => (), }
    match options.once { Some(value) => { arguments = arguments.extend(["--once", value]); } None() => (), }
    match options.check { Some(value) => { arguments = arguments.push("--check").extend(value); } None() => (), }
    return arguments;
}
