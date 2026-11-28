module app.main;

import nomo.adapters.storage.workspace.ConfigurationCache as Store0;
import nomo.adapters.storage.journals.FileJournals as Store1;
import nomo.adapters.storage.jobs.ProcessJobs as Store2;
import nomo.adapters.storage.workspace.Projects as Store3;
import nomo.adapters.storage.chat.LegacyChats as Store4;
import nomo.adapters.storage.chat.ChatHistories as Store5;
import nomo.adapters.storage.check_lifecycle.CheckOutputs as Store6;
import nomo.adapters.storage.session_records.DemoClaims as Store7;
import nomo.adapters.storage.work_admission.ContinuousBooks as Store8;
import nomo.adapters.storage.edits.EditOperations as Store9;
import nomo.adapters.storage.edits.FollowupEditOperations as Store10;
import nomo.adapters.storage.session_records.EventHistory as Store11;
import nomo.adapters.storage.checkpoints.Checkpoints as Store12;
import nomo.adapters.storage.checkpoints.Successors as Store13;
import nomo.adapters.storage.checks.HistoryChecks as Store14;
import nomo.adapters.storage.followup_checks.FollowupChecks as Store15;
import nomo.adapters.storage.work_admission.HistoryWorkRuns as Store16;
import nomo.adapters.storage.followup.FollowupRuns as Store17;
import nomo.adapters.storage.checks.RecoverableChecks as Store18;
import nomo.adapters.storage.chat.RecoverableChats as Store19;
import nomo.adapters.storage.chat.ChatEvidenceRows as Store20;
import nomo.adapters.storage.followup_checks.RecoverableFollowupChecks as Store21;
import nomo.adapters.storage.followup.RecoverableFollowups as Store22;
import nomo.adapters.storage.work_admission.RecoverableWorks as Store23;
import nomo.adapters.storage.chains.RecoveryDecisions as Store24;
import nomo.adapters.storage.session_records.SessionMetadata as Store25;
import nomo.adapters.storage.chains.ChainJournal as Store26;
import nomo.adapters.storage.chains.Chains as Store27;
import nomo.adapters.storage.edits.WorkRecords as Store28;
import nomo.adapters.storage.conversations.Data as Store29;
import nomo.adapters.storage.conversations.Copies as Store30;
import nomo.adapters.storage.jobs.ArchivedJobs as Store31;
import nomo.adapters.storage.journals.Data as Store32;
import nomo.adapters.storage.legacy.user_context_chain_v4_journal.UserContextJournal as Store33;
import nomo.adapters.storage.legacy.user_context_chain_v4_store.UserContextChain as Store34;
import nomo.domain.changes.{JournalPhase, StepPhase};
import nomo.domain.attempts.AttemptPhase;
import nomo.domain.processes.{JobPhase, JobEventKind, ArchivedJobPhase};
import nomo.domain.archives.{CopyKind, CopyPhase};
import nomo.domain.conversation.{TraceEvent, TraceRole, TraceKind, wire_trace};
import nomo.domain.sessions.state.{DemoClaimPhase, SessionMode, SessionLifecycle, EventReference, ReferencePhase, wire_reference};
import nomo.domain.sessions.chain.{RecoveryChoice, ChainPhase, ChainEditPhase};
import nomo.domain.sessions.chat.ChatPhase;
import nomo.domain.editing.LiteralEditPhase;
import nomo.domain.harness.read.{ReadContext, ReadStage};
import nomo.domain.harness.loop.ReadOperation;
import nomo.domain.sessions.checkpoints.{CheckpointRecordPhase, SuccessorRecordPhase};
import nomo.domain.sessions.work.{
    CheckSlot,
    CheckState,
    CheckOutcome,
    WorkPhase,
    FollowupPhase,
    StoredWorkPhase,
    SummaryState,
    SummaryProvenance,
    SummarySource,
    WorkProfile,
    CheckAttempt,
    wire_check_attempt,
    wire_continuous
};
import nomo.domain.wire.encode;
import std.codec.text.utf8_encode;
import std.io.println;

flow expect(value: bool, label: string) -> unit ![] {
    if !value {
        abort(label);
    }
}

flow protocol<T>(label: string, value: T) -> unit ![Console, Error<std.io.IOError>] {
    println(
        "[PROTOCOL] " + label + "=" + match encode(value, "projection failed", "encoding failed") {
            Ok(value) => value,
            Err(error) => abort(error)
        }
    );
}

public flow main(args: Array<string>) -> i32 ![
    Memory,
    Console,
    Error<StorageError>,
    Error<IndexError>,
    Error<BudgetExceeded>,
    Error<std.io.IOError>
] {
    let source_0: Store<string, nomo.domain.settings.CachedConfiguration> = Store0.Parsed;
    let row_0: nomo.domain.settings.CachedConfiguration = match source_0.get("row-0") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_1: Store<string, nomo.domain.changes.FileJournal> = Store1.Journals;
    let row_1: nomo.domain.changes.FileJournal = match source_1.get("row-1") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_2: Store<string, nomo.domain.changes.FileStep> = Store1.Steps;
    let row_2: nomo.domain.changes.FileStep = match source_2.get("row-2") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_3: Store<string, nomo.domain.processes.ProcessJob> = Store2.Jobs;
    let row_3: nomo.domain.processes.ProcessJob = match source_3.get("row-3") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_4: Store<string, nomo.domain.processes.ProcessOutput> = Store2.Outputs;
    let row_4: nomo.domain.processes.ProcessOutput = match source_4.get("row-4") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_5: Store<string, Array<string>> = Store3.Recent;
    let row_5: Array<string> = match source_5.get("row-5") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_6: Store<string, nomo.domain.sessions.chat.ChatSessionState> = Store4.Rows;
    let row_6: nomo.domain.sessions.chat.ChatSessionState = match source_6.get("row-6") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_7: Store<string, nomo.domain.sessions.chat.ChatHistorySnapshot> = Store5.Rows;
    let row_7: nomo.domain.sessions.chat.ChatHistorySnapshot = match source_7.get("row-7") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_8: Store<string, nomo.domain.sessions.work.CapturedCheckOutput> = Store6.Rows;
    let row_8: nomo.domain.sessions.work.CapturedCheckOutput = match source_8.get("row-8") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_9: Store<string, nomo.domain.sessions.state.DemoSessionClaim> = Store7.Claims;
    let row_9: nomo.domain.sessions.state.DemoSessionClaim = match source_9.get("row-9") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_10: Store<string, nomo.domain.sessions.work.ContinuousWorkHistory> = Store8.Rows;
    let row_10: nomo.domain.sessions.work.ContinuousWorkHistory = match source_10.get("row-10") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_11: Store<string, nomo.domain.editing.LiteralEditRecord> = Store9.Rows;
    let row_11: nomo.domain.editing.LiteralEditRecord = match source_11.get("row-11") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_12: Store<string, nomo.domain.editing.LiteralEditRecord> = Store10.Rows;
    let row_12: nomo.domain.editing.LiteralEditRecord = match source_12.get("row-12") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_13: Store<string, nomo.domain.sessions.event_codec.RecordedTraceHistory> = Store11.Rows;
    let row_13: nomo.domain.sessions.event_codec.RecordedTraceHistory = match source_13.get("row-13") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_14: Store<string, nomo.domain.sessions.checkpoints.StoredCheckpoint> = Store12.Rows;
    let row_14: nomo.domain.sessions.checkpoints.StoredCheckpoint = match source_14.get("row-14") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_15: Store<string, nomo.domain.sessions.checkpoints.StoredSuccessor> = Store13.Rows;
    let row_15: nomo.domain.sessions.checkpoints.StoredSuccessor = match source_15.get("row-15") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_16: Store<string, nomo.domain.sessions.work.CheckAttempt> = Store14.Rows;
    let row_16: nomo.domain.sessions.work.CheckAttempt = match source_16.get("row-16") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_17: Store<string, nomo.domain.sessions.work.CheckAttempt> = Store15.Rows;
    let row_17: nomo.domain.sessions.work.CheckAttempt = match source_17.get("row-17") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_18: Store<string, nomo.domain.sessions.work.WorkAttempt> = Store16.Rows;
    let row_18: nomo.domain.sessions.work.WorkAttempt = match source_18.get("row-18") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_19: Store<string, nomo.domain.sessions.work.FollowupAttempt> = Store17.Rows;
    let row_19: nomo.domain.sessions.work.FollowupAttempt = match source_19.get("row-19") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_20: Store<string, nomo.domain.sessions.work.CapturedCheckAttempt> = Store18.Rows;
    let row_20: nomo.domain.sessions.work.CapturedCheckAttempt = match source_20.get("row-20") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_21: Store<string, nomo.domain.sessions.chat.ChatSessionSnapshot> = Store19.Rows;
    let row_21: nomo.domain.sessions.chat.ChatSessionSnapshot = match source_21.get("row-21") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_22: Store<string, nomo.domain.sessions.chat.ChatEvidence> = Store20.Rows;
    let row_22: nomo.domain.sessions.chat.ChatEvidence = match source_22.get("row-22") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_23: Store<string, nomo.domain.sessions.work.CapturedCheckAttempt> = Store21.Rows;
    let row_23: nomo.domain.sessions.work.CapturedCheckAttempt = match source_23.get("row-23") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_24: Store<string, nomo.domain.sessions.work.FollowupSessionFrame> = Store22.Rows;
    let row_24: nomo.domain.sessions.work.FollowupSessionFrame = match source_24.get("row-24") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_25: Store<string, nomo.domain.sessions.work.WorkSessionFrame> = Store23.Rows;
    let row_25: nomo.domain.sessions.work.WorkSessionFrame = match source_25.get("row-25") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_26: Store<string, nomo.domain.sessions.chain.RecordedRecovery> = Store24.Rows;
    let row_26: nomo.domain.sessions.chain.RecordedRecovery = match source_26.get("row-26") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_27: Store<string, nomo.domain.sessions.state.StoredSessionMetadata> = Store25.Rows;
    let row_27: nomo.domain.sessions.state.StoredSessionMetadata = match source_27.get("row-27") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_28: Store<string, nomo.domain.sessions.chain.ChainEditJournal> = Store26.Rows;
    let row_28: nomo.domain.sessions.chain.ChainEditJournal = match source_28.get("row-28") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_29: Store<string, nomo.domain.sessions.chain.WorkChain> = Store27.Rows;
    let row_29: nomo.domain.sessions.chain.WorkChain = match source_29.get("row-29") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_30: Store<string, nomo.domain.sessions.work.CapturedWork> = Store28.Rows;
    let row_30: nomo.domain.sessions.work.CapturedWork = match source_30.get("row-30") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_31: Store<string, i64> = Store29.Counters;
    let row_31: i64 = match source_31.get("row-31") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_32: Store<string, string> = Store29.Selected;
    let row_32: string = match source_32.get("row-32") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_33: Store<string, nomo.domain.conversation.SavedSession> = Store29.Sessions;
    let row_33: nomo.domain.conversation.SavedSession = match source_33.get("row-33") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_34: Store<string, nomo.domain.conversation.StoredEvent> = Store29.Events;
    let row_34: nomo.domain.conversation.StoredEvent = match source_34.get("row-34") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_35: Store<string, string> = Store29.Chunks;
    let row_35: string = match source_35.get("row-35") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_36: Store<string, nomo.domain.archives.ConversationCopy> = Store30.Jobs;
    let row_36: nomo.domain.archives.ConversationCopy = match source_36.get("row-36") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_37: Store<string, nomo.domain.processes.ArchivedProcessJob> = Store31.Jobs;
    let row_37: nomo.domain.processes.ArchivedProcessJob = match source_37.get("row-37") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_38: Store<string, bytes> = Store31.Parts;
    let row_38: bytes = match source_38.get("row-38") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_39: Store<string, i64> = Store32.Counter;
    let row_39: i64 = match source_39.get("row-39") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_40: Store<string, nomo.domain.attempts.ExecutionAttempt> = Store32.Attempts;
    let row_40: nomo.domain.attempts.ExecutionAttempt = match source_40.get("row-40") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_41: Store<string, nomo.domain.sessions.user_context_chain_v4.RootBoundChainJournal> = Store33.Rows;
    let row_41: nomo.domain.sessions.user_context_chain_v4.RootBoundChainJournal = match source_41.get("row-41") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    let source_42: Store<string, nomo.domain.sessions.user_context_chain_v4.RootBoundWorkChain> = Store34.Rows;
    let row_42: nomo.domain.sessions.user_context_chain_v4.RootBoundWorkChain = match source_42.get("row-42") {
        Some(value) => value,
        None() => abort("missing migrated row")
    };
    expect(row_1.phase == JournalPhase.Applying, "journal applying retained");
    expect(row_2.phase == StepPhase.Applying, "step applying retained");
    expect(row_3.phase == JobPhase.Started, "job state retained");
    expect(row_4.phase == JobEventKind.Output && row_4.exit_code == Some(37), "output event retained");
    expect(row_6.phase == ChatPhase.Running, "chat reservation retained");
    expect(row_8.slot == CheckSlot.First, "check slot typed");
    expect(row_9.phase == DemoClaimPhase.ContinueClaimed, "one-shot claim retained");
    expect(
        row_10.history[0].result.phase == SummaryState.Complete(SummaryProvenance.V5(SummarySource.Model)),
        "historical provenance retained"
    );
    expect(
        row_10.current.result.phase == SummaryState.Running(WorkProfile.HighInputV2),
        "configured reservation retained"
    );
    expect(
        row_10.history[0].check.phase == CheckState.Complete(CheckOutcome.Failed(37)),
        "failed check numeric code"
    );
    expect(row_10.current.check.phase == CheckState.Running, "running check remains unresolved");
    expect(row_11.phase == LiteralEditPhase.Intent, "literal edit intent retained");
    expect(
        row_13.events[0].role == TraceRole.User
            && row_13.events[0].kind == TraceKind.Input,
        "fixed trace vocabulary"
    );
    expect(row_14.phase == CheckpointRecordPhase.Claimed, "checkpoint claim retained");
    expect(row_15.phase == SuccessorRecordPhase.Admitted, "successor admission retained");
    expect(row_16.phase == CheckState.Running, "check reservation retained");
    expect(row_17.phase == CheckState.Complete(CheckOutcome.Passed), "passed result typed");
    expect(row_18.phase == WorkPhase.Abandoned, "abandoned work not completed");
    expect(row_19.phase == FollowupPhase.Running, "followup reservation retained");
    expect(
        row_26.choice == RecoveryChoice.Abandon
            && row_18.phase == WorkPhase.Abandoned,
        "recovery decision does not settle effect"
    );
    expect(
        row_27.snapshot.mode == SessionMode.Stub
            && row_27.snapshot.lifecycle == SessionLifecycle.RecoveryRequired,
        "session mode and recovery state"
    );
    expect(row_28.phase == ChainEditPhase.Intent, "journal intent retained");
    expect(row_29.phase == ChainPhase.Admitted, "chain admission retained");
    expect(row_30.phase == StoredWorkPhase.SummaryUnconfirmed, "unconfirmed summary retained");
    expect(row_31 == 9007199254740993, "exact large integer counter");
    expect(row_1.call == 9007199254740993, "exact large integer journal call");
    expect(row_36.kind == CopyKind.Fork && row_36.phase == CopyPhase.Copying, "copy progress retained");
    expect(row_37.phase == ArchivedJobPhase.Unknown, "archived job has no live claim");
    expect(row_38 == utf8_encode("鹈鹕\0\n"), "raw bytes exact");
    expect(row_39 == 9007199254740993, "exact large integer attempt counter");
    expect(row_40.phase == AttemptPhase.ClosedUnknown, "unknown attempt remains unknown");
    expect(
        row_41.phase == ChainEditPhase.Intent
            && row_42.base.phase == ChainPhase.Admitted,
        "v4 root namespace retained"
    );
    expect(row_34.role == "鹈鹕\\nreserved: role", "open imported role retained verbatim");
    protocol(
        "trace",
        wire_trace(TraceEvent {
            role = TraceRole.User,
            kind = TraceKind.Input,
            name = "",
            text = "鹈鹕\n"
        })
    );
    protocol(
        "check",
        wire_check_attempt(
            CheckAttempt {
                format = 1,
                phase = CheckState.Complete(CheckOutcome.Failed(37)),
                id = "check",
                digest = "digest"
            }
        )
    );
    protocol("reference", wire_reference(EventReference.Bound("operation", ReferencePhase.Request)));
    protocol("continuous", wire_continuous(row_10.current));
    let context: ReadContext = ReadContext {
        phase = ReadStage.Aggregate,
        request = "question",
        task = "task",
        result = "result",
        tool = Some(ReadOperation.Search),
        outcome = "complete: result",
        allowed = ["a.txt"]
    };
    protocol("context", context.wire());
    println("PASS typed reads of 43 stores; unresolved state, provenance, numeric codes and exact counters retained");
    return 0;
}
