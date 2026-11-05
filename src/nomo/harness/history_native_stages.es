module nomo.harness.history_native_stages;

public enum Stage { ReadPlan, ReadSummary, EditPlan, EditChild, EditSummary }
@limits([Tokens(2048), ContextTokens(8192)])
agent ReadPlan(input: Prompt) -> string { return perform infer<string>(input); }
// Wide work stages share one run-owned 2,811,008-token ledger. Tokens keeps
// each stage's output cap separate from that cumulative input/output ceiling.
@limits([Tokens(4096), ContextTokens(2811008)])
agent WideReadPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(2048), ContextTokens(262144)])
agent Summary(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(4096), ContextTokens(2811008)])
agent WideStage(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(8192), ContextTokens(2811008)])
agent WideEditPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(32768), ContextTokens(262144)])
agent EditChild(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(131072), ContextTokens(2811008)])
agent WideEditChild(input: Prompt) -> string { return perform infer<string>(input); }
// High-input work preserves every recovered conversation event. Its seven
// stages share a larger run-owned ledger; only the edit child is narrowed to
// its 32768-byte protocol ceiling so prompt plus reserved output can coexist.
@limits([Tokens(4096), ContextTokens(6000000)])
agent HighInputReadPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(4096), ContextTokens(6000000)])
agent HighInputStage(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(8192), ContextTokens(6000000)])
agent HighInputEditPlan(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(32768), ContextTokens(6000000)])
agent HighInputEditChild(input: Prompt) -> string { return perform infer<string>(input); }

public flow infer_stage<T>(stage: Stage, wide: bool, high_input: bool, system: string, input: T) -> string {
    let prompt = Prompt.new().system(Trusted(system)).data(input);
    return match stage {
        Stage.ReadPlan => if high_input { HighInputReadPlan.run(prompt) } else { if wide { WideReadPlan.run(prompt) } else { ReadPlan.run(prompt) } },
        Stage.ReadSummary => if high_input { HighInputStage.run(prompt) } else { if wide { WideStage.run(prompt) } else { Summary.run(prompt) } },
        Stage.EditPlan => if high_input { HighInputEditPlan.run(prompt) } else { if wide { WideEditPlan.run(prompt) } else { WideStage.run(prompt) } },
        Stage.EditChild => if high_input { HighInputEditChild.run(prompt) } else { if wide { WideEditChild.run(prompt) } else { EditChild.run(prompt) } },
        Stage.EditSummary => if high_input { HighInputStage.run(prompt) } else { if wide { WideStage.run(prompt) } else { Summary.run(prompt) } },
    };
}
