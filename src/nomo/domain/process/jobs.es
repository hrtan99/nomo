module nomo.domain.process.jobs;

// Keep the canonical stored nominal identities as passive compatibility contracts.
// A saved Job is metadata, never a live process capability.
public import nomo.native.processes.{Job, JobEvent};

public type StartRequest = { operation: string, program: string, arguments: Array<string> };
public type JobRequest = { operation: string, job: string, handle: string };
public type ReadRequest = { operation: string, job: string, handle: string, max_bytes: usize };
public type WriteRequest = { operation: string, job: string, handle: string, input: string };
public type InputResult = { job: string, operation: string, status: string };
