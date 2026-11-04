module nomo.harness.history_native_stages;

import nomo.harness.read_tool_chat.LargeChatMain;

public enum Stage { ReadPlan, ReadSummary, EditPlan, EditChild, EditSummary }
@limits([Tokens(2048), ContextTokens(8192)])
agent ReadPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(4096), ContextTokens(8192)])
agent WideReadPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(2048), ContextTokens(262144)])
agent Summary(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(4096), ContextTokens(262144)])
agent WideStage(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(8192), ContextTokens(262144)])
agent WideEditPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(32768), ContextTokens(262144)])
agent EditChild(input: Prompt) -> string { return perform infer<string>(input); }

public flow infer_stage<T>(stage: Stage, wide: bool, system: string, input: T) -> string {
    let prompt = Prompt.new().system(Trusted(system)).data(input);
    return match stage {
        Stage.ReadPlan => if wide { WideReadPlan.run(prompt) } else { ReadPlan.run(prompt) },
        Stage.ReadSummary => if wide { WideStage.run(prompt) } else { Summary.run(prompt) },
        Stage.EditPlan => if wide { WideEditPlan.run(prompt) } else { WideStage.run(prompt) },
        Stage.EditChild => if wide { LargeChatMain.run(prompt) } else { EditChild.run(prompt) },
        Stage.EditSummary => if wide { WideStage.run(prompt) } else { Summary.run(prompt) },
    };
}
