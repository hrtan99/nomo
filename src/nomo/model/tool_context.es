module nomo.model.tool_context;

import std.text.len;
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.tools.path_policy.valid_path;

public type Context = { history: Array<Event>, allowed: Array<string>, final_only: bool };

public flow allowed_error(names: Array<string>) -> string {
    if count(names) < 1 || count(names) > 2 { return "expected one or two allowed files"; }
    for name in names limit Iterations(2) {
        if len(name) > 48 || !valid_path(name) { return "invalid allowed file"; }
    }
    if count(names) == 2 && names[0] == names[1] { return "duplicate allowed file"; }
    return "";
}

// Bound the closed String/Bool payload before encoding. This is an input
// allocation bound, not a token estimate or a generic typed-value serializer.
public flow bounded_context_error(value: Context) -> string {
    let invalid = allowed_error(value.allowed); if invalid != "" { return invalid; }
    if count(value.history) > 32 { return "context history exceeds 32 events"; }
    for event in value.history limit Iterations(32) {
        if len(event.role) > 128 || len(event.kind) > 128 || len(event.name) > 128 || len(event.text) > 8192 {
            return "context event exceeds bounded input";
        }
    }
    return "";
}
