module nomo.adapters.storage.processes;

import std.memory.MemoryCursor;
import std.text.from_i64;
import nomo.native.processes.Data;
import nomo.domain.process.jobs.{Job, JobEvent};
import nomo.application.processes.ports.{JobRepository, OutputArchive};
import nomo.application.context.ports.SavedJobsReader;

public type NativeJobs = {};
impl NativeJobs ~ JobRepository {
    flow load(self, id: string) -> Option<Job> ![Memory, Error<StorageError>] { return Data.Jobs.get(id); }
    flow insert(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.insert(value.id, value); }
    flow save(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.put(value.id, value); }
    flow list(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        var result: Array<Job> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = Data.Jobs.page(cursor, 100);
            result = result.extend(page.entries.iter()
                .filter(item => item.value.session == session)
                .map(item => item.value).collect());
            match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
        }
        return result;
    }
}
impl NativeJobs ~ SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>] {
        return self.list(session);
    }
}
public type NativeOutputArchive = {};
impl NativeOutputArchive ~ OutputArchive {
    flow insert(self, session: string, call: i64, value: JobEvent) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Outputs.insert(session + ":" + from_i64(call), value); }
    flow find(self, session: string, index: string) -> Option<JobEvent> ![Memory, Error<StorageError>] { return Data.Outputs.get(session + ":" + index); }
}
