module nomo.model.tool_context;

import std.text.char_count as len;
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.tools.path_policy.valid_path;

public type Context = { history: Array<Event>, allowed: Array<string>, final_only: bool };

flow paths_error(names: Array<string>, maximum: usize, path_limit: usize) -> string {
    if count(names) < 1 || count(names) > maximum { return if maximum == 4 { "expected one to four allowed files" } else { "expected 1..256 discovered files" }; }
    for name in names limit Iterations(256) {
        if len(name) > path_limit || !valid_path(name) { return "invalid allowed file"; }
    }
    var i: usize = 0;
    while i < count(names) limit Iterations(256) {
        var j = i + 1;
        while j < count(names) limit Iterations(256) {
            if names[i] == names[j] { return "duplicate allowed file"; }
            j = j + 1;
        }
        i = i + 1;
    }
    return "";
}

public flow allowed_error(names: Array<string>) -> string { return paths_error(names, 4, 128); }
public flow candidate_error(names: Array<string>) -> string { return paths_error(names, 256, 128); }

// Bound the closed String/Bool payload before encoding. This is an input
// allocation bound, not a token estimate or a generic typed-value serializer.
public flow bounded_context_error(value: Context) -> string {
    let invalid = candidate_error(value.allowed); if invalid != "" { return invalid; }
    if count(value.history) > 32 { return "context history exceeds 32 events"; }
    for event in value.history limit Iterations(32) {
        if len(event.role) > 128 || len(event.kind) > 128 || len(event.name) > 128 || len(event.text) > 262154 {
            return "context event exceeds bounded input";
        }
    }
    return "";
}
