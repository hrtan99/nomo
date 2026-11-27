module app.main;

import std.effects.Inject;

spec Changes { flow apply(self, text: string) -> string ![]; }
type LocalChanges = {};
impl LocalChanges ~ Changes {
    flow apply(self, text: string) -> string ![] { return text; }
}

public tool apply(text: string, @inject changes: ? ~ Changes) -> string
    ![Inject<? ~ Changes>] {
    return changes.apply(text);
}

@tools([apply])
agent Coder = {};
impl Coder {
    public flow run(self) -> string ![Inject<? ~ Changes>] {
        return perform infer<string>(Prompt.new().system(Trusted("Synthetic injection example")));
    }
}

public flow main(args: Array<string>) -> i32 ![Agentic] {
    let changes: ? ~ Changes = LocalChanges {};
    let answer = (Coder {}).run() with { changes: ? ~ Changes => changes; };
    return 0;
}
