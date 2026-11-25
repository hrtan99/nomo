module nomo.domain.process.jobs;

// A view of saved metadata, not a live process handle or liveness claim.
public type Job = { id: string, session: string, program: string, arguments: Array<string>, handle: string, phase: string };

// Raw bytes accompany display text; these records do not replace stored types.
public type JobEvent = { job: string, call: i64, phase: string, exit_code: Option<i32>, stdout: string, stderr: string, stdout_bytes: bytes, stderr_bytes: bytes };
public type StartRequest = { operation: string, program: string, arguments: Array<string> };
public type JobRequest = { operation: string, job: string, handle: string };
public type ReadRequest = { operation: string, job: string, handle: string, max_bytes: usize };
public type WriteRequest = { operation: string, job: string, handle: string, input: string };
public type InputResult = { job: string, operation: string, status: string };
