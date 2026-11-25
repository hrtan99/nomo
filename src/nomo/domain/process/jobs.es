module nomo.domain.process.jobs;

// A view of saved metadata, not a live process handle or liveness claim.
public type Job = { id: string, session: string, program: string, arguments: Array<string>, handle: string, phase: string };
