module nomo.session.store_record;

import nomo.session.session_state.Snapshot;

public type Record = {
    format: i32,
    phase: string,
    save_id: string,
    session_key: string,
    snapshot: Snapshot
};
