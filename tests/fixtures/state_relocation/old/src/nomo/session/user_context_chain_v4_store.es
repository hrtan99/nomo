module nomo.session.user_context_chain_v4_store;

import nomo.session.user_context_chain_v4.Record;

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Chain = std.memory.region<Schema>(
    stable_id = "nomo-user-context-chain-v4",
    store = "user-context-chain"
);
