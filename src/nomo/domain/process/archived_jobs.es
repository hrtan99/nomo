module nomo.domain.process.archived_jobs;

// Old project jobs have a workspace owner and a last saved observation, not a
// conversation owner or a reconnectable native process capability.
public type ArchivedJob = { id: string, workspace: string, arguments: Array<string>,
    phase: string, exit_code: Option<i32>, output_bytes: usize, parts: usize, original: string };
