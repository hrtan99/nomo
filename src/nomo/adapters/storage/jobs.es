module nomo.adapters.storage.jobs;

import nomo.application.conversation.ports.SavedJobsReader;
import nomo.application.execution.ports.{ArchivedJobCatalog, ArchivedJobParts, JobRepository, OutputArchive};
import nomo.domain.processes.{ArchivedJob, Job, JobEvent};
import std.memory.MemoryCursor;
import std.text.{from_i64, from_usize};

alias ArchivedSchema = MemoryRegion<{
    Jobs: Store<string, ArchivedJob>,
    Parts: Store<string, bytes>
}>;

public let ArchivedJobs = std.memory.region<ArchivedSchema>(
    stable_id = "nomo-native-project-jobs-v1",
    store = "native-project-jobs"
);

public type NativeJobs = {};

impl NativeJobs ~ JobRepository {
    flow load(self, id: string) -> Option<Job> ![Memory, Error<StorageError>] {
        return ProcessJobs.Jobs.get(id);
    }

    flow insert(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        ProcessJobs.Jobs.insert(value.id, value);
    }

    flow save(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        ProcessJobs.Jobs.put(value.id, value);
    }

    flow list(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        var result: Array<Job> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = ProcessJobs.Jobs.page(cursor, 100);
            result = result.extend(
                page.entries.iter()
                    .filter(item => item.value.session == session)
                    .map(item => item.value).collect()
            );
            match page.cursor {
                Some(value) => {
                    cursor = Some(value);
                }
                None() => {
                    break;
                }
            }
        }
        return result;
    }
}

impl NativeJobs ~ SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        return self.list(session);
    }
}

impl NativeJobs ~ ArchivedJobCatalog {
    flow archived_job(self, id: string) -> Option<ArchivedJob> ![Memory, Error<StorageError>] {
        return ArchivedJobs.Jobs.get(id);
    }

    flow archived_jobs(self, workspace: string) -> Array<ArchivedJob> ![
        Memory,
        Error<StorageError>,
        Error<BudgetExceeded>
    ] {
        var result: Array<ArchivedJob> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = ArchivedJobs.Jobs.page(cursor, 100);
            result = result.extend(page.entries.iter().filter(item => item.value.workspace == workspace).map(item => item.value).collect());
            match page.cursor {
                Some(value) => {
                    cursor = Some(value);
                }
                None() => {
                    break;
                }
            }
        }
        return result;
    }
}

impl NativeJobs ~ ArchivedJobParts {
    flow archived_part(self, job: string, part: usize) -> Option<bytes> ![Memory, Error<StorageError>] {
        return ArchivedJobs.Parts.get(job + "/" + from_usize(part));
    }
}

public type NativeOutputArchive = {};

impl NativeOutputArchive ~ OutputArchive {
    flow insert(self, session: string, call: i64, value: JobEvent) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ] {
        ProcessJobs.Outputs.insert(session + ":" + from_i64(call), value);
    }

    flow find(self, session: string, index: string) -> Option<JobEvent> ![Memory, Error<StorageError>] {
        return ProcessJobs.Outputs.get(session + ":" + index);
    }
}

alias ProcessJobsSchema = MemoryRegion<{
    Jobs: Store<string, Job>,
    Outputs: Store<string, JobEvent>
}>;

public let ProcessJobs = std.memory.region<ProcessJobsSchema>(
    stable_id = "nomo-native-processes-v1",
    store = "native-processes"
);
