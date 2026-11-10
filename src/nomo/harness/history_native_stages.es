module nomo.harness.history_native_stages;

import nomo.harness.typed_work_contract.Delegation;
import nomo.tools.edit_contribution.Contribution;
import nomo.core.json.encode;

public enum Stage { ReadPlan, ReadSummary, EditPlan, EditChild, EditSummary }
@limits([Tokens(2048), ContextTokens(8192)])
agent ReadPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
// Wide work stages share one run-owned 2,811,008-token ledger. Tokens keeps
// each stage's output cap separate from that cumulative input/output ceiling.
@limits([Tokens(4096), ContextTokens(2811008)])
agent WideReadPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
@limits([Tokens(2048), ContextTokens(262144)])
agent Summary(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(4096), ContextTokens(2811008)])
agent WideStage(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(8192), ContextTokens(2811008)])
agent WideEditPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
@limits([Tokens(4096), ContextTokens(2811008)])
agent EditPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
@limits([Tokens(32768), ContextTokens(262144)])
agent EditChild(input: Prompt) -> Contribution { return perform infer<Contribution>(input); }
@limits([Tokens(131072), ContextTokens(2811008)])
agent WideEditChild(input: Prompt) -> Contribution { return perform infer<Contribution>(input); }
// High-input work mirrors the current Codex ceiling: every one of its seven
// model calls may generate 128K tokens, including hidden reasoning.
@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputReadPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputStage(input: Prompt) -> string { return perform infer<string>(input); }
@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputEditPlan(input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputEditChild(input: Prompt) -> Contribution { return perform infer<Contribution>(input); }

flow frame(fields: Array<string>) -> string {
    return match encode(fields, "work stage conversion failed", "work stage encoding failed") { Ok(value) => value, Err(error) => { abort(error); } };
}
flow delegated(value: Delegation) -> string { return frame(["delegate", value.task]); }
flow contributed(value: Contribution) -> string { return frame(["edit", value.target, value.replacement]); }

public flow infer_stage<T>(stage: Stage, wide: bool, high_input: bool, system: string, input: T) -> string {
    let prompt = Prompt.new().system(Trusted(system)).data(input);
    return match stage {
        Stage.ReadPlan => delegated(if high_input { HighInputReadPlan.run(prompt) } else { if wide { WideReadPlan.run(prompt) } else { ReadPlan.run(prompt) } }),
        Stage.ReadSummary => if high_input { HighInputStage.run(prompt) } else { if wide { WideStage.run(prompt) } else { Summary.run(prompt) } },
        Stage.EditPlan => delegated(if high_input { HighInputEditPlan.run(prompt) } else { if wide { WideEditPlan.run(prompt) } else { EditPlan.run(prompt) } }),
        Stage.EditChild => contributed(if high_input { HighInputEditChild.run(prompt) } else { if wide { WideEditChild.run(prompt) } else { EditChild.run(prompt) } }),
        Stage.EditSummary => if high_input { HighInputStage.run(prompt) } else { if wide { WideStage.run(prompt) } else { Summary.run(prompt) } },
    };
}
