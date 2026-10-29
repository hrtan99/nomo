module app.callable_negative;

import nomo.harness.harness_tool_chat_contract.{Context, empty};
import nomo.harness.legacy_chat_stages.ChatMainStage;

flow bad(context: Context) -> bool ~ ChatMainStage { return true; }
public flow main(args: Array<string>) -> i32 {
    let context = Context { phase = "plan", request = "Q", task = "", result = "", tool = "", outcome = "", allowed = ["a.txt"], prior = empty() };
    let value = bad(context);
    return 0;
}
