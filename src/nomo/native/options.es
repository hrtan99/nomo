module nomo.native.options;

import std.collections.len;

public type Options = { workspace: string, resume_id: string, fresh: bool, once: Option<string>, choose_project: bool };

public flow parse(args: Array<string>) -> Options ![Error<IndexError>] {
    var workspace = "";
    var resume_id = "";
    var fresh = false;
    var choose_project = false;
    var once: Option<string> = None();
    var index: usize = 0;
    while index < len(args) limit Iterations(2147483647) {
        let option = args[index];
        if option == "--new" { fresh = true; index = index + 1; continue; }
        if option == "--open" { choose_project = true; index = index + 1; continue; }
        if index + 1 >= len(args) { abort("native entry expects --workspace PATH, optional --resume ID, --new or --once REQUEST"); }
        let value = args[index + 1];
        if option == "--workspace" { workspace = value; }
        else if option == "--resume" { resume_id = value; }
        else if option == "--once" { once = Some(value); }
        else { abort("unknown native entry option: " + option); }
        index = index + 2;
    }
    if workspace == "" { abort("provide --workspace with the folder mounted as /project"); }
    return Options { workspace = workspace, resume_id = resume_id, fresh = fresh, once = once, choose_project = choose_project };
}
