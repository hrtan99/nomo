module nomo.application.processes.ports;

import std.fs.WorkspacePath;
import std.io.IOError;
import nomo.native.workspace.ProjectRoot;
import nomo.domain.process.jobs.{Job, JobEvent, InputResult};
import nomo.domain.process.observations.ProcessEvent;
import nomo.domain.process.archived_jobs.{ArchivedJob, ArchivedOutput};

// Live is the implementation's transient capability, never persisted as a Job.
public spec ProcessControl<Live> {
    flow root(self) -> WorkspacePath<ProjectRoot> ![];
    flow start(self, root: WorkspacePath<ProjectRoot>, program: string, arguments: Array<string>) -> Live ![Command.start<DefaultCommandSandbox>];
    flow reference(self, process: Live) -> string ![];
    flow attach(self, reference: string) -> Live ![Command.reconnect<DefaultCommandSandbox>];
    flow read(self, process: Live, max_bytes: usize) -> ProcessEvent ![Command.read<DefaultCommandSandbox>];
    flow write(self, process: Live, input: bytes) -> unit ![Command.write<DefaultCommandSandbox>];
    flow close_input(self, process: Live) -> unit ![Command.write<DefaultCommandSandbox>];
    flow stop(self, process: Live) -> ProcessEvent ![Command.stop<DefaultCommandSandbox>];
}

public spec JobRepository {
    flow load(self, id: string) -> Option<Job> ![Memory, Error<StorageError>];
    flow insert(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow save(self, value: Job) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow list(self, session: string) -> Array<Job> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}

public spec OutputArchive {
    flow insert(self, session: string, call: i64, value: JobEvent) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
    flow find(self, session: string, event: string) -> Option<JobEvent> ![Memory, Error<StorageError>];
}

public spec ArchivedJobCatalog {
    flow archived_job(self, id: string) -> Option<ArchivedJob> ![Memory, Error<StorageError>];
    flow archived_jobs(self, workspace: string) -> Array<ArchivedJob> ![Memory, Error<StorageError>, Error<BudgetExceeded>];
}
public spec ArchivedJobParts {
    flow archived_part(self, job: string, part: usize) -> Option<bytes> ![Memory, Error<StorageError>];
}

public spec ProcessPreviewSink { flow write(self, line: string) -> unit ![Console, Error<IOError>]; }

// Session is carried across the outer bootstrap handler explicitly.
public effect ProcessOperations {
    action start(session: string, program: string, arguments: Array<string>) -> Job;
    action read(session: string, job: string, max_bytes: usize) -> JobEvent;
    action write(session: string, job: string, input: string) -> InputResult;
    action close_input(session: string, job: string) -> InputResult;
    action stop(session: string, job: string) -> JobEvent;
    action list(session: string) -> Array<Job>;
    action output(session: string, job: string) -> Array<JobEvent>;
    action archived_jobs(session: string) -> Array<ArchivedJob>;
    action archived_output(session: string, job: string, part: usize) -> ArchivedOutput;
}
