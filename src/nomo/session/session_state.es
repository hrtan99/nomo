module nomo.session.session_state;

import nomo.core.conversation.State;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Draft typed application data, not a codec, storage version or dispatch authority.
public type Caps = {
    steps: i32,
    turn_steps: i32,
    attempts: i32,
    tokens: i32,
    scan_bytes: i32
};

public type Ledger = {
    attempts: i32,
    tokens: i32,
    scan_bytes: i32,
    step_unit: string,
    attempt_unit: string,
    token_unit: string,
    scan_unit: string
};

public type Operation = {
    id: string,
    status: string,
    attempts: i32,
    tokens: i32,
    scan_bytes: i32
};

public type Reference = {
    operation: string,
    phase: string
};

public type Snapshot = {
    format: i32,
    session_id: string,
    generation: i32,
    mode: string,
    binding: string,
    lifecycle: string,
    history: State,
    references: Array<Reference>,
    operations: Array<Operation>,
    original_caps: Caps,
    current_caps: Caps,
    ledger: Ledger
};
