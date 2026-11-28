module nomo.session.work_chain_journal;

import nomo.session.edit_operation.Binding;

public type Record = {
    format: i32,
    chain: string,
    turn: i32,
    phase: string,
    binding: Binding
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Journal = std.memory.region<Schema>(
    stable_id = "nomo-work-chain-edit-v2",
    store = "work-chain-edit"
);
