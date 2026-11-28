module nomo.session.recoverable_work_store;

import nomo.session.recoverable_events.Frame as EventFrame;
import nomo.session.history_work_guard.Record;

public type Frame = {
    format: i32,
    policy_binding: string,
    work: Record,
    events: EventFrame
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Frame>
}>;

public let Runs = std.memory.region<Schema>(
    stable_id = "nomo-recoverable-work-v1",
    store = "recoverable-work"
);
