module nomo.domain.migration.native_state;

import nomo.domain.conversation.session.Session as SavedSession;
import nomo.native.history.Event as SavedEvent;
import nomo.domain.transfer.copy.CopyJob;
import nomo.domain.execution.attempt.Attempt as SavedAttempt;
import nomo.native.configuration.Cached;
import nomo.native.mutations.{Journal as SavedJournal, Step as SavedStep};
import nomo.domain.process.jobs.{Job as SavedJob, JobEvent};

// Stored facts, including incomplete records, are copied without executing them.
public enum NativeRecord {
    Counter(string, i64), Selected(string, string), Session(string, SavedSession),
    Event(string, SavedEvent), Chunk(string, string), Copy(string, CopyJob),
    AttemptCounter(string, i64), Attempt(string, SavedAttempt),
    Configuration(string, Cached), Projects(string, Array<string>),
    Journal(string, SavedJournal), Step(string, SavedStep), Job(string, SavedJob), Output(string, JobEvent)
}

public type NativeImage = { source_sha256: string, records: Array<NativeRecord> };
public type MigrationReport = { source_sha256: string, rows: usize };
