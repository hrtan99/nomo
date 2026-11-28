module nomo.native.processes;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
// phase is the last recorded Host observation, not a claim of current liveness.
public type Job = {
    id: string,
    session: string,
    program: string,
    arguments: Array<string>,
    handle: string,
    phase: string
};

public type JobEvent = {
    job: string,
    call: i64,
    phase: string,
    exit_code: Option<i32>,
    stdout: string,
    stderr: string,
    stdout_bytes: bytes,
    stderr_bytes: bytes
};

alias Schema = MemoryRegion<{
    Jobs: Store<string, Job>,
    Outputs: Store<string, JobEvent>
}>;

public let Data = std.memory.region<Schema>(
    stable_id = "nomo-native-processes-v1",
    store = "native-processes"
);
