module nomo.domain.conversation.start;

public enum SessionSelection { Current, Fresh, Existing, Exact(string), Choose }

public type Options = { workspace: string, selection: SessionSelection, once: Option<string>,
    open_project: Option<string>, projects: bool, sessions: bool, all_sessions: bool,
    history: bool, status: bool, title: Option<string>, import_path: Option<string>,
    export_path: Option<string>, check: Option<Array<string>> };

public flow offline(options: Options) -> bool {
    return options.projects || options.sessions || options.history || options.status ||
        match options.export_path { Some(_) => true, None() => false };
}
