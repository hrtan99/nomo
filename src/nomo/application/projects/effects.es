module nomo.application.projects.effects;

import nomo.domain.projects.selection.LaunchRequest;

public effect ProjectDisplay {
    action item(index: usize, path: string) -> unit;
    action choose() -> string;
    action preview(path: string) -> unit;
}
public effect ProjectOperations {
    action remember(workspace: string) -> unit;
    action show() -> unit;
    action open(raw: string, workspace: string, arguments: Array<string>) -> bool;
    action launch(request: LaunchRequest) -> unit;
}
