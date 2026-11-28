module nomo.session.work_chain;

import nomo.session.work_record.Record as WorkRecord;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.

public type Caps = {
    steps: i32,
    calls: i32,
    generation: i32,
    native_tokens: i32,
    read_tools: i32,
    scan: i32,
    edit_reads: i32,
    edit_read_bytes: i32,
    atomic: i32,
    atomic_bytes: i32
};

public type Record = {
    format: i32,
    phase: string,
    chain: string,
    turn: i32,
    id: string,
    workspace: string,
    region: string,
    path: string,
    request: string,
    allowed: Array<string>,
    parent_id: string,
    parent_version: string,
    parent_digest: string,
    maximum: Caps,
    available: Caps,
    remaining: Caps,
    reserved: Caps,
    work: Option<WorkRecord>
};
