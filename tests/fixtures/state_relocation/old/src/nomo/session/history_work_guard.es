module nomo.session.history_work_guard;

import nomo.harness.harness_work_contract.Ledger;

public type Budget = {
    steps: i32,
    calls: i32,
    generation: i32,
    native_tokens: i32
};

public type Record = {
    format: i32,
    phase: string,
    id: string,
    workspace: string,
    path: string,
    request: string,
    history_version: string,
    reserved: Budget,
    settled: Option<Ledger>,
    summary: string
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Runs = std.memory.region<Schema>(stable_id = "nomo-history-work-v1", store = "history-work");
