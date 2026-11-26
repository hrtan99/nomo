module nomo.session.check_output;

// Compatibility identity only. Runtime logic lives in domain/application/adapters.
// Output is untrusted diagnostic text, never authority or evidence that a
// command may run again. Records bind to an independently completed check.
public type Record = { format: i32, slot: string, id: string, digest: string,
    stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;

public let Outputs = std.memory.region<Schema>(stable_id = "nomo-check-output-v1", store = "check-output");
