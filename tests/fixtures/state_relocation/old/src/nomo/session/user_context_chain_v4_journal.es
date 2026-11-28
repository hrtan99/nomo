module nomo.session.user_context_chain_v4_journal;

import nomo.session.edit_operation.Binding;
import nomo.session.user_context_chain_v4.RootIdentity;

public type Record = {
    format: i32,
    chain: string,
    turn: i32,
    phase: string,
    root: RootIdentity,
    binding: Binding
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Journal = std.memory.region<Schema>(
    stable_id = "nomo-user-context-edit-v4",
    store = "user-context-edit"
);
