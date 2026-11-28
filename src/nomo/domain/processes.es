module nomo.domain.processes;

import std.codec.text.{Replace, utf8_decode};

// Old project jobs have a workspace owner and a last saved observation, not a
// conversation owner or a reconnectable native process capability.
public type ArchivedJob = {
    id: string,
    workspace: string,
    arguments: Array<string>,
    phase: string,
    exit_code: Option<i32>,
    output_bytes: usize,
    parts: usize,
    original: string
};

// Old project jobs have a workspace owner and a last saved observation, not a
// conversation owner or a reconnectable native process capability.
public type ArchivedOutput = {
    job: string,
    part: usize,
    next_part: Option<usize>,
    total_bytes: usize,
    data: bytes
};

public type StartRequest = {
    operation: string,
    program: string,
    arguments: Array<string>
};

public type JobRequest = {
    operation: string,
    job: string,
    handle: string
};

public type ReadRequest = {
    operation: string,
    job: string,
    handle: string,
    max_bytes: usize
};

public type WriteRequest = {
    operation: string,
    job: string,
    handle: string,
    input: string
};

public type InputResult = {
    job: string,
    operation: string,
    status: string
};

public enum ProcessEvent {
    Output(bytes, bytes),
    Exited(i32, bytes, bytes),
    Stopped(bytes, bytes)
}

flow display(value: bytes) -> string {
    return match utf8_decode(value, Replace) {
        Ok(text) => text,
        Err(_) => abort("process output conversion failed"),
    };
}

public flow observed(job: string, call: i64, value: ProcessEvent) -> JobEvent {
    return match value {
        ProcessEvent.Output(stdout, stderr) => JobEvent {
            job,
            call,
            phase = "output",
            exit_code = None(),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        },
        ProcessEvent.Exited(code, stdout, stderr) => JobEvent {
            job,
            call,
            phase = "exited",
            exit_code = Some(code),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        },
        ProcessEvent.Stopped(stdout, stderr) => JobEvent {
            job,
            call,
            phase = "stopped",
            exit_code = None(),
            stdout = display(stdout),
            stderr = display(stderr),
            stdout_bytes = stdout,
            stderr_bytes = stderr
        }
    };
}

public flow recorded_phase(previous: string, observed: string) -> string {
    return if observed == "output" {
        previous
    } else {
        observed
    };
}

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
