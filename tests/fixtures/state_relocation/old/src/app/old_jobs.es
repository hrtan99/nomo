module app.old_jobs;

import nomo.domain.process.archived_jobs.ArchivedJob;
import nomo.native.processes.Data;
import nomo.native.processes.Job;
import nomo.native.processes.JobEvent;
import std.memory.MemoryCursor;
import std.text.from_i64;
import std.text.from_usize;

alias ArchivedSchema = MemoryRegion<{
    Jobs: Store<string, ArchivedJob>,
    Parts: Store<string, bytes>
}>;

public let ArchivedJobs = std.memory.region<ArchivedSchema>(
    stable_id = "nomo-native-project-jobs-v1",
    store = "native-project-jobs"
);
