module nomo.session.recovery_decision;



public type Decision = {
    format: i32,
    id: string,
    target: string,
    choice: string
};

alias Schema = MemoryRegion<{
    Rows: Store<string, Decision>
}>;

public let Decisions = std.memory.region<Schema>(
    stable_id = "nomo-recovery-decision-v1",
    store = "recovery-decision"
);
