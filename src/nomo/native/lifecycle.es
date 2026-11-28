module nomo.native.lifecycle;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
public type Attempt = {
    id: string,
    session: string,
    kind: string,
    label: string,
    phase: string,
    input_event: i64,
    through: i64,
    result_event: i64,
    recovery_event: i64
};
