module nomo.domain.context.instructions;

import std.text.{split, rsplit_once};

public type ProjectInstruction = { scope: string, path: string, text: string };

public flow guide_path(scope: string) -> string {
    return if scope == "." { "AGENTS.md" } else { scope + "/AGENTS.md" };
}

// Candidate ancestor scopes only. The reader still observes existence in order.
public flow child_scopes(normalized: string) -> Array<string> {
    let parent = match rsplit_once(normalized, "/") { Some((value, _)) => value, None() => "." };
    var result: Array<string> = [];
    var scope = ".";
    for component in split(parent, "/") limit Iterations(2147483647) {
        if component == "." || component == "" { continue; }
        scope = if scope == "." { component } else { scope + "/" + component };
        result = result.push(scope);
    }
    return result;
}
