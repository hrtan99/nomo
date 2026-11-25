module nomo.application.native.projects.effects;

public effect ProjectDisplay {
    action item(index: usize, path: string) -> unit;
    action choose() -> string;
    action preview(path: string) -> unit;
}
public effect ProjectOperations {
    action remember(workspace: string) -> unit;
    action show() -> unit;
    action open(raw: string, workspace: string) -> bool;
}
