module nomo.harness.harness_tool_chat_contract;

import nomo.harness.harness_tool_contract.Ledger;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Only validated successful selected data crosses a turn boundary.
public type Previous = { task: string, result: string, tool: string, outcome: string, answer: string };

public type Invocation = { usage: Ledger, maximum: Ledger, admitted: i32, prior: Previous };
