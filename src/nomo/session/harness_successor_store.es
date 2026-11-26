module nomo.session.harness_successor_store;

import nomo.session.harness_checkpoint.Identity;
import nomo.harness.harness_tool_contract.Ledger;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type Record = { format: i32, phase: string, predecessor: Identity, successor: Identity,
    predecessor_version: string, predecessor_body: string, request: string, body: string,
    usage: Ledger, maximum: Ledger, reserved: Ledger, admitted: i32, resolved: bool };

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;

public let Successors = std.memory.region<Schema>(stable_id = "nomo-harness-successor-v1", store = "harness-successor");
