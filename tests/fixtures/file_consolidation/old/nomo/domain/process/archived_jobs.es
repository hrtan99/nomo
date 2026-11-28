module nomo.domain.process.archived_jobs;

// The pre-consolidation defining identity and representation, retained only as
// a producer fixture for an actual old-writer/new-reader SQLite check.
public type ArchivedJob = { id: string, workspace: string, arguments: Array<string>,
    phase: string, exit_code: Option<i32>, output_bytes: usize, parts: usize, original: string };
