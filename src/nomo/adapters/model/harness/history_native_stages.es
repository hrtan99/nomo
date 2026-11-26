module nomo.adapters.model.harness.history_native_stages;

import nomo.adapters.model.prompt_encoding;


import nomo.domain.harness.typed_work_contract.Delegation;
import nomo.domain.mutations.edit_contribution.Contribution;
import nomo.domain.serialization.json.encode;
import nomo.domain.harness.history_native_stages.Stage;

@limits([Tokens(2048), ContextTokens(8192)])
public agent ReadPlan = {};

impl ReadPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

// Wide work stages share one run-owned 2,811,008-token ledger. Tokens keeps
// each stage's output cap separate from that cumulative input/output ceiling.
@limits([Tokens(4096), ContextTokens(2811008)])
agent WideReadPlan = {};

impl WideReadPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

@limits([Tokens(2048), ContextTokens(262144)])
agent Summary = {};

impl Summary {
    public flow run(self, input: Prompt) -> string { return perform infer<string>(input); }
}

@limits([Tokens(4096), ContextTokens(2811008)])
agent WideStage = {};

impl WideStage {
    public flow run(self, input: Prompt) -> string { return perform infer<string>(input); }
}

@limits([Tokens(8192), ContextTokens(2811008)])
agent WideEditPlan = {};

impl WideEditPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

@limits([Tokens(4096), ContextTokens(2811008)])
public agent EditPlan = {};

impl EditPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

@limits([Tokens(32768), ContextTokens(262144)])
public agent EditChild = {};

impl EditChild {
    public flow run(self, input: Prompt) -> Contribution { return perform infer<Contribution>(input); }
}

@limits([Tokens(131072), ContextTokens(2811008)])
agent WideEditChild = {};

impl WideEditChild {
    public flow run(self, input: Prompt) -> Contribution { return perform infer<Contribution>(input); }
}

// High-input work mirrors the current Codex ceiling: every one of its seven
// model calls may generate 128K tokens, including hidden reasoning.
@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputReadPlan = {};

impl HighInputReadPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputStage = {};

impl HighInputStage {
    public flow run(self, input: Prompt) -> string { return perform infer<string>(input); }
}

@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputEditPlan = {};

impl HighInputEditPlan {
    public flow run(self, input: Prompt) -> Delegation { return perform infer<Delegation>(input); }
}

@limits([Tokens(131072), ContextTokens(7340032)])
agent HighInputEditChild = {};

impl HighInputEditChild {
    public flow run(self, input: Prompt) -> Contribution { return perform infer<Contribution>(input); }
}

flow frame(fields: Array<string>) -> string {
    return match encode(fields, "work stage conversion failed", "work stage encoding failed") { Ok(value) => value, Err(error) => abort(error), };
}

flow delegated(value: Delegation) -> string { return frame(["delegate", value.task]); }

flow contributed(value: Contribution) -> string { return frame(["edit", value.target, value.replacement]); }

public flow infer_stage<T>(stage: Stage, wide: bool, high_input: bool, system: Trusted<string>, input: T) -> string {
    let prompt = Prompt.new().system(system).data(prompt_encoding.input(input));
    return match stage {
        Stage.ReadPlan => delegated(if high_input { (HighInputReadPlan {}).run(prompt) } else { if wide { (WideReadPlan {}).run(prompt) } else { (ReadPlan {}).run(prompt) } }),
        Stage.ReadSummary => if high_input { (HighInputStage {}).run(prompt) } else { if wide { (WideStage {}).run(prompt) } else { (Summary {}).run(prompt) } },
        Stage.EditPlan => delegated(if high_input { (HighInputEditPlan {}).run(prompt) } else { if wide { (WideEditPlan {}).run(prompt) } else { (EditPlan {}).run(prompt) } }),
        Stage.EditChild => contributed(if high_input { (HighInputEditChild {}).run(prompt) } else { if wide { (WideEditChild {}).run(prompt) } else { (EditChild {}).run(prompt) } }),
        Stage.EditSummary => if high_input { (HighInputStage {}).run(prompt) } else { if wide { (WideStage {}).run(prompt) } else { (Summary {}).run(prompt) } },
    };
}
