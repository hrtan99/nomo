module nomo.adapters.storage.context_inputs;

import nomo.application.context.ports.SavedJobsReader;
import nomo.adapters.storage.processes.NativeJobs;
import nomo.domain.process.jobs.Job;

public type SavedJobContext = { jobs: NativeJobs };
impl SavedJobContext ~ SavedJobsReader {
    flow read(self, session: string) -> Array<Job> ![Memory, Error<StorageError>] {
        return self.jobs.list(session);
    }
}
