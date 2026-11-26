module nomo.harness.harness_tool_contract;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
public type Ledger = { steps: i32, calls: i32, tokens: i32, tools: i32, scan: i32 };
