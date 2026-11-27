module nomo.adapters.storage.native_migration;

import nomo.application.migration.ports.NativeStateDestination;
import nomo.domain.migration.native_state.NativeRecord;
import nomo.adapters.storage.conversations.{Data as Conversations, Copies};
import nomo.adapters.storage.attempts.Data as Attempts;
import nomo.native.configuration.Data as Configuration;
import nomo.native.projects.Data as Projects;
import nomo.native.mutations.Data as Mutations;
import nomo.native.processes.Data as Jobs;

public type NativeStateWriter = {};
impl NativeStateWriter ~ NativeStateDestination {
    flow insert(self, record: NativeRecord) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        match record {
            NativeRecord.Counter(key, value) => Conversations.Counters.insert(key, value),
            NativeRecord.Selected(key, value) => Conversations.Selected.insert(key, value),
            NativeRecord.Session(key, value) => Conversations.Sessions.insert(key, value),
            NativeRecord.Event(key, value) => Conversations.Events.insert(key, value),
            NativeRecord.Chunk(key, value) => Conversations.Chunks.insert(key, value),
            NativeRecord.Copy(key, value) => Copies.Jobs.insert(key, value),
            NativeRecord.AttemptCounter(key, value) => Attempts.Counter.insert(key, value),
            NativeRecord.Attempt(key, value) => Attempts.Attempts.insert(key, value),
            NativeRecord.Configuration(key, value) => Configuration.Parsed.insert(key, value),
            NativeRecord.Projects(key, value) => Projects.Recent.insert(key, value),
            NativeRecord.Journal(key, value) => Mutations.Journals.insert(key, value),
            NativeRecord.Step(key, value) => Mutations.Steps.insert(key, value),
            NativeRecord.Job(key, value) => Jobs.Jobs.insert(key, value),
            NativeRecord.Output(key, value) => Jobs.Outputs.insert(key, value),
        }
    }
}
