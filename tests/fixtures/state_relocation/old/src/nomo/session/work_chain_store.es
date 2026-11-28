module nomo.session.work_chain_store;

import nomo.session.work_chain.Record;

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Chain = std.memory.region<Schema>(stable_id = "nomo-work-chain-v2", store = "work-chain");
