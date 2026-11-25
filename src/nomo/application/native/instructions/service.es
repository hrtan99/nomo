module nomo.application.native.instructions.service;

import nomo.application.native.instructions.ports.InstructionFiles;
import nomo.domain.context.instructions.{ProjectInstruction, guide_path, child_scopes};

flow guide(scope: string) -> Option<ProjectInstruction> {
    let name = guide_path(scope);
    let entries = perform InstructionFiles.entries(scope);
    for item in entries limit Iterations(2147483647) {
        if item == name { return Some(ProjectInstruction { scope = scope, path = name, text = perform InstructionFiles.text(name) }); }
    }
    return None();
}

public flow load(pathname: string) -> Array<ProjectInstruction> {
    let normalized = perform InstructionFiles.normalize(pathname);
    var result: Array<ProjectInstruction> = [];
    var scope = ".";
    match guide(scope) { Some(value) => { result = result.push(value); } None() => {} }
    for next in child_scopes(normalized) limit Iterations(2147483647) {
        var present = false;
        let entries = perform InstructionFiles.entries(scope);
        for item in entries limit Iterations(2147483647) { if item == next { present = true; } }
        if !present { break; }
        scope = next;
        match guide(scope) { Some(value) => { result = result.push(value); } None() => {} }
    }
    return result;
}
