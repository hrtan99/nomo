module nomo.session.history_check_store;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
public type Record = { format: i32, phase: string, id: string, digest: string, outcome: string, exit_code: string };
