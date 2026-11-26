module nomo.adapters.storage.processes;

import std.memory.MemoryCursor;
import std.text.from_i64;
import nomo.native.processes.{Data, Job as StoredJob, JobEvent as StoredEvent};
import nomo.domain.process.jobs.{Job, JobEvent};
import nomo.application.processes.ports.{JobRepository, OutputArchive};
import nomo.application.context.ports.SavedJobsReader;

flow job(value: StoredJob) -> Job {
    return Job { id = value.id, session = value.session, program = value.program, arguments = value.arguments, handle = value.handle, phase = value.phase };
}
flow stored_job(value: Job) -> StoredJob {
    return StoredJob { id = value.id, session = value.session, program = value.program, arguments = value.arguments, handle = value.handle, phase = value.phase };
}
flow event(value: StoredEvent) -> JobEvent {
    return JobEvent { job = value.job, call = value.call, phase = value.phase, exit_code = value.exit_code, stdout = value.stdout, stderr = value.stderr, stdout_bytes = value.stdout_bytes, stderr_bytes = value.stderr_bytes };
}
flow stored_event(value: JobEvent) -> StoredEvent {
    return StoredEvent { job = value.job, call = value.call, phase = value.phase, exit_code = value.exit_code, stdout = value.stdout, stderr = value.stderr, stdout_bytes = value.stdout_bytes, stderr_bytes = value.stderr_bytes };
}

public type NativeJobs = {};
impl NativeJobs ~ JobRepository {
    flow load(self, id: string) -> Option<Job> ![Memory, Error<StorageError>] { return match Data.Jobs.get(id) { Some(value) => Some(job(value)), None() => None() }; }
    flow insert(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.insert(value.id, stored_job(value)); }
    flow save(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Jobs.put(value.id, stored_job(value)); }
    flow list(self, session: string) -> Array<Job> ![Memory, Error<StorageError>] {
        var result: Array<Job> = [];
        var cursor: Option<MemoryCursor> = None();
        @limits([Iterations(2147483647)]) while true {
            let page = Data.Jobs.page(cursor, 100);
            result = result.extend(page.entries.iter()
                .filter(item => item.value.session == session)
                .map(item => job(item.value)).collect());
            match page.cursor { Some(value) => { cursor = Some(value); } None() => { break; } }
        }
        return result;
    }
}
impl NativeJobs ~ SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>] {
        return self.list(session);
    }
}
public type NativeOutputArchive = {};
impl NativeOutputArchive ~ OutputArchive {
    flow insert(self, session: string, call: i64, value: JobEvent) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] { Data.Outputs.insert(session + ":" + from_i64(call), stored_event(value)); }
    flow find(self, session: string, index: string) -> Option<JobEvent> ![Memory, Error<StorageError>] { return match Data.Outputs.get(session + ":" + index) { Some(value) => Some(event(value)), None() => None() }; }
}
