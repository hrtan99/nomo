module nomo.domain.process.archived_jobs;



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
