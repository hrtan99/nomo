module nomo.harness.harness_tool_chat_contract;

import nomo.harness.harness_tool_contract.Ledger;

public type Previous = {
    task: string,
    result: string,
    tool: string,
    outcome: string,
    answer: string
};

public type Invocation = {
    usage: Ledger,
    maximum: Ledger,
    admitted: i32,
    prior: Previous
};
