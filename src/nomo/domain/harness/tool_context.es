module nomo.domain.harness.tool_context;

import std.text.char_count as len;
import nomo.core.conversation.Event;
import nomo.domain.context.path_policy.valid_path;
import nomo.domain.context.large_context.outcome_bytes;

public type Context = { history: Array<Event>, allowed: Array<string>, final_only: bool };

flow paths_error(names: Array<string>, maximum: usize, path_limit: usize) -> string {
    if names.len() < 1 || names.len() > maximum { return if maximum == 4 { "expected one to four allowed files" } else { "expected 1..256 discovered files" }; }
    @limits([Iterations(256)]) for name in names {
        if len(name) > path_limit || !valid_path(name) { return "invalid allowed file"; }
    }
    var i: usize = 0;
    @limits([Iterations(256)]) while i < names.len() {
        var j = i + 1;
        @limits([Iterations(256)]) while j < names.len() {
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
    if value.history.len() > 32 { return "context history exceeds 32 events"; }
    @limits([Iterations(32)]) for event in value.history {
        if len(event.role) > 128 || len(event.kind) > 128 || len(event.name) > 128 || len(event.text) > outcome_bytes() {
            return "context event exceeds bounded input";
        }
    }
    return "";
}
