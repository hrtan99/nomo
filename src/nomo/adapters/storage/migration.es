module nomo.adapters.storage.migration;

import nomo.adapters.storage.conversations.{Copies, Data, append_historical};
import nomo.adapters.storage.jobs.ArchivedJobs;
import nomo.adapters.storage.journals.Data as journals_Data;
import nomo.application.transfer.ports.{HistoricalEvents, NativeStateDestination};
import nomo.domain.archives.NativeRecord;
import nomo.native.configuration.Data as configuration_Data;
import nomo.native.mutations.Data as mutations_Data;
import nomo.native.processes.Data as processes_Data;
import nomo.native.projects.Data as projects_Data;

public type NativeStateWriter = {};

impl NativeStateWriter ~ HistoricalEvents {
    flow append(self, session: string, role: string, name: string, text: string) -> i64
        ![Memory, Error<StorageError>, Error<MemoryConflict>, Error<BudgetExceeded>] {
        return append_historical(session, role, name, text);
    }
}

impl NativeStateWriter ~ NativeStateDestination {
    flow insert(self, record: NativeRecord) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        match record {
            NativeRecord.Counter(key, value) => Data.Counters.insert(key, value),
            NativeRecord.Selected(key, value) => Data.Selected.insert(key, value),
            NativeRecord.Session(key, value) => Data.Sessions.insert(key, value),
            NativeRecord.Event(key, value) => Data.Events.insert(key, value),
            NativeRecord.Chunk(key, value) => Data.Chunks.insert(key, value),
            NativeRecord.Copy(key, value) => Copies.Jobs.insert(key, value),
            NativeRecord.AttemptCounter(key, value) => journals_Data.Counter.insert(key, value),
            NativeRecord.Attempt(key, value) => journals_Data.Attempts.insert(key, value),
            NativeRecord.Configuration(key, value) => configuration_Data.Parsed.insert(key, value),
            NativeRecord.Projects(key, value) => projects_Data.Recent.insert(key, value),
            NativeRecord.Journal(key, value) => mutations_Data.Journals.insert(key, value),
            NativeRecord.Step(key, value) => mutations_Data.Steps.insert(key, value),
            NativeRecord.Job(key, value) => processes_Data.Jobs.insert(key, value),
            NativeRecord.Output(key, value) => processes_Data.Outputs.insert(key, value),
            NativeRecord.ArchivedJob(key, value) => ArchivedJobs.Jobs.insert(key, value),
            NativeRecord.ArchivedPart(key, value) => ArchivedJobs.Parts.insert(key, value),
        }
    }
}
