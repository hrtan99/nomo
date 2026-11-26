module nomo.application.instructions.service;

import nomo.application.instructions.ports.InstructionFiles;
import nomo.domain.context.instructions.{ProjectInstruction, guide_path, child_scopes};

flow guide(scope: string) -> Option<ProjectInstruction> {
    let name = guide_path(scope);
    let entries = perform InstructionFiles.entries(scope);
    if entries.iter().any(item => item == name) {
        return Some(ProjectInstruction { scope, path = name, text = perform InstructionFiles.text(name) });
    }
    return None();
}

public flow load(pathname: string) -> Array<ProjectInstruction> {
    let normalized = perform InstructionFiles.normalize(pathname);
    var result: Array<ProjectInstruction> = [];
    var scope = ".";
    match guide(scope) { Some(value) => { result = result.push(value); } None() => (), }
    for next in child_scopes(normalized) {
        let entries = perform InstructionFiles.entries(scope);
        if !entries.iter().any(item => item == next) { break; }
        scope = next;
        match guide(scope) { Some(value) => { result = result.push(value); } None() => (), }
    }
    return result;
}
