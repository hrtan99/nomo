module app.callable_negative;

import nomo.domain.harness.chat.Context;
import nomo.domain.harness.chat.empty;
import nomo.application.harness.ports.ChatMainStage;

flow bad(context: Context) -> bool ~ ChatMainStage { return true; }
public flow main(args: Array<string>) -> i32 {
    let context = Context { phase = "plan", request = "Q", task = "", result = "", tool = "", outcome = "", allowed = ["a.txt"], prior = empty() };
    let value = bad(context);
    return 0;
}
