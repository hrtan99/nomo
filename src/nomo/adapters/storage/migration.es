module nomo.adapters.storage.migration;

import nomo.adapters.storage.chains.{ChainJournal, Chains, RecoveryDecisions};
import nomo.adapters.storage.chat.{ChatEvidenceRows, ChatHistories, LegacyChats, RecoverableChats};
import nomo.adapters.storage.check_lifecycle.CheckOutputs;
import nomo.adapters.storage.checkpoints.{Checkpoints, Successors};
import nomo.adapters.storage.checks.{HistoryChecks, RecoverableChecks};
import nomo.adapters.storage.conversations.{Copies, Data, append_historical};
import nomo.adapters.storage.edits.{EditOperations, FollowupEditOperations, WorkRecords};
import nomo.adapters.storage.followup.{FollowupRuns, RecoverableFollowups};
import nomo.adapters.storage.followup_checks.{FollowupChecks, RecoverableFollowupChecks};
import nomo.adapters.storage.jobs.{ArchivedJobs, ProcessJobs};
import nomo.adapters.storage.journals.{Data as journals_Data, FileJournals};
import nomo.adapters.storage.session_records.{DemoClaims, EventHistory, SessionMetadata};
import nomo.adapters.storage.work_admission.{ContinuousBooks, HistoryWorkRuns, RecoverableWorks};
import nomo.adapters.storage.workspace.{ConfigurationCache, Projects};
import nomo.application.transfer.ports.{HistoricalEvents, NativeStateDestination, RelocatedStateDestination};
import nomo.domain.archives.{NativeRecord, RelocatedRow};

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
            NativeRecord.Configuration(key, value) => ConfigurationCache.Parsed.insert(key, value),
            NativeRecord.Projects(key, value) => Projects.Recent.insert(key, value),
            NativeRecord.Journal(key, value) => FileJournals.Journals.insert(key, value),
            NativeRecord.Step(key, value) => FileJournals.Steps.insert(key, value),
            NativeRecord.Job(key, value) => ProcessJobs.Jobs.insert(key, value),
            NativeRecord.Output(key, value) => ProcessJobs.Outputs.insert(key, value),
            NativeRecord.ArchivedJob(key, value) => ArchivedJobs.Jobs.insert(key, value),
            NativeRecord.ArchivedPart(key, value) => ArchivedJobs.Parts.insert(key, value),
        }
    }
}

// Decode with the ordinary destination codec and perform an ordinary Memory
// insert. Schema metadata, receipts and protected versions are never forged.
public flow restore_relocated<T ~ std.memory.StorageData>(store: Store<string, T>, row: RelocatedRow) -> unit
![Memory, Error<StorageError>, Error<MemoryConflict>] {
    let codec = std.memory.codec<T>();
    let value = match (codec.decode)(row.value) {
        Ok(value) => value,
        Err(error) => perform Error.raise<StorageError>(error),
    };
    store.insert(row.key, value);
}

impl NativeStateWriter ~ RelocatedStateDestination {
    flow insert(self, row: RelocatedRow) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        match row.store {
            "nomo-native-configuration-v1/Parsed" => restore_relocated(
                ConfigurationCache.Parsed,
                row
            ),
            "nomo-native-file-journals-v1/Journals" => restore_relocated(FileJournals.Journals, row),
            "nomo-native-file-journals-v1/Steps" => restore_relocated(FileJournals.Steps, row),
            "nomo-native-processes-v1/Jobs" => restore_relocated(ProcessJobs.Jobs, row),
            "nomo-native-processes-v1/Outputs" => restore_relocated(ProcessJobs.Outputs, row),
            "nomo-native-projects-v1/Recent" => restore_relocated(Projects.Recent, row),
            "nomo-chat-history-v1/Rows" => restore_relocated(LegacyChats.Rows, row),
            "nomo-chat-history-v3/Rows" => restore_relocated(ChatHistories.Rows, row),
            "nomo-check-output-v1/Rows" => restore_relocated(CheckOutputs.Rows, row),
            "nomo-session-demo-v1/Claims" => restore_relocated(DemoClaims.Claims, row),
            "nomo-continuous-work-v1/Rows" => restore_relocated(ContinuousBooks.Rows, row),
            "nomo-edit-operation-v1/Rows" => restore_relocated(EditOperations.Rows, row),
            "nomo-edit-followup-v1/Rows" => restore_relocated(FollowupEditOperations.Rows, row),
            "nomo-event-history-v1/Rows" => restore_relocated(EventHistory.Rows, row),
            "nomo-harness-checkpoint-v1/Rows" => restore_relocated(Checkpoints.Rows, row),
            "nomo-harness-successor-v1/Rows" => restore_relocated(Successors.Rows, row),
            "nomo-history-check-v1/Rows" => restore_relocated(HistoryChecks.Rows, row),
            "nomo-followup-check-v1/Rows" => restore_relocated(FollowupChecks.Rows, row),
            "nomo-history-work-v1/Rows" => restore_relocated(HistoryWorkRuns.Rows, row),
            "nomo-history-followup-v1/Rows" => restore_relocated(FollowupRuns.Rows, row),
            "nomo-recoverable-check-v1/Rows" => restore_relocated(RecoverableChecks.Rows, row),
            "nomo-recoverable-chat-v1/Rows" => restore_relocated(RecoverableChats.Rows, row),
            "nomo-recoverable-chat-evidence-v1/Rows" => restore_relocated(
                ChatEvidenceRows.Rows,
                row
            ),
            "nomo-recoverable-followup-check-v1/Rows" => restore_relocated(
                RecoverableFollowupChecks.Rows,
                row
            ),
            "nomo-recoverable-followup-v1/Rows" => restore_relocated(RecoverableFollowups.Rows, row),
            "nomo-recoverable-work-v1/Rows" => restore_relocated(RecoverableWorks.Rows, row),
            "nomo-recovery-decision-v1/Rows" => restore_relocated(RecoveryDecisions.Rows, row),
            "nomo-session-store-v1/Rows" => restore_relocated(SessionMetadata.Rows, row),
            "nomo-work-chain-edit-v2/Rows" => restore_relocated(ChainJournal.Rows, row),
            "nomo-work-chain-v2/Rows" => restore_relocated(Chains.Rows, row),
            "nomo-work-record-v1/Rows" => restore_relocated(WorkRecords.Rows, row),
            "nomo-native-conversations-v1/Counters" => restore_relocated(Data.Counters, row),
            "nomo-native-conversations-v1/Selected" => restore_relocated(Data.Selected, row),
            "nomo-native-conversations-v1/Sessions" => restore_relocated(Data.Sessions, row),
            "nomo-native-conversations-v1/Events" => restore_relocated(Data.Events, row),
            "nomo-native-conversations-v1/Chunks" => restore_relocated(Data.Chunks, row),
            "nomo-native-conversation-copies-v1/Jobs" => restore_relocated(Copies.Jobs, row),
            "nomo-native-project-jobs-v1/Jobs" => restore_relocated(ArchivedJobs.Jobs, row),
            "nomo-native-project-jobs-v1/Parts" => restore_relocated(ArchivedJobs.Parts, row),
            "nomo-native-attempts-v1/Counter" => restore_relocated(journals_Data.Counter, row),
            "nomo-native-attempts-v1/Attempts" => restore_relocated(journals_Data.Attempts, row),
            _ => abort("unsupported relocated state store: " + row.store),
        }
    }
}
