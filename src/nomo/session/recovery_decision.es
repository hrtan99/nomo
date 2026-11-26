module nomo.session.recovery_decision;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
// A recorded choice does not prove the side-effect outcome, grant authority,
// release a budget, alter the original record, or authorize a retry.
public type Decision = { format: i32, id: string, target: string, choice: string };

alias Schema = MemoryRegion<{ Rows: Store<string, Decision> }>;

public let Decisions = std.memory.region<Schema>(stable_id = "nomo-recovery-decision-v1", store = "recovery-decision");
