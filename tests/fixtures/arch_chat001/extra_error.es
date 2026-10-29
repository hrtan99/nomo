module app.callable_negative;

import std.fs.Region;
import nomo.core.conversation.State;
import nomo.model.model_tool_contract.{LoopTurn, fresh_loop};
import nomo.harness.legacy_chat_stages.ChatChildStage;

type FixtureRoot;
impl FixtureRoot ~ Region;
flow bad(task: string, files: Array<string>, selected: State) -> LoopTurn ![Error<string>] ~ ChatChildStage<FixtureRoot> {
    if task != "" { perform Error<string>.raise("intentional outside-bound error"); }
    return LoopTurn { state = fresh_loop(), status = 4 };
}
public flow main(args: Array<string>) -> i32 {
    let prior = fresh_loop();
    let value = bad("T", ["a.txt"], prior.history);
    return 0;
}
