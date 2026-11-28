module nomo.session.store_record;

import nomo.session.session_state.Snapshot;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

// Application metadata only: event bodies belong to the single Session bundle.
public type Record = {
    format: i32,
    phase: string,
    save_id: string,
    session_key: string,
    snapshot: Snapshot
};
