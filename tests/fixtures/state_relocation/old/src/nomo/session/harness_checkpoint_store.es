module nomo.session.harness_checkpoint_store;

import nomo.session.harness_checkpoint.Identity;

public type Record = {
    format: i32,
    phase: string,
    identity: Identity,
    body: string
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Record>
}>;

public let Checkpoints = std.memory.region<Schema>(
    stable_id = "nomo-harness-checkpoint-v1",
    store = "harness-checkpoint"
);
