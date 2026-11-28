module app.historical_sources;

import nomo.native.configuration.Cached as S0;
import nomo.native.mutations.Journal as S1;
import nomo.native.mutations.Step as S2;
import nomo.native.processes.Job as S3;
import nomo.native.processes.JobEvent as S4;
import nomo.session.chat_session_contract.Session as S5;
import nomo.session.chat_history.Frame as S6;
import nomo.session.check_output.Record as S7;
import nomo.session.demo_claim.Claim as S8;
import nomo.session.continuous_work.Book as S9;
import nomo.session.edit_operation.Record as S10;
import nomo.session.event_history.History as S11;
import nomo.session.harness_checkpoint_store.Record as S12;
import nomo.session.harness_successor_store.Record as S13;
import nomo.session.history_check_store.Record as S14;
import nomo.session.history_work_guard.Record as S15;
import nomo.session.history_followup_guard.Record as S16;
import nomo.session.check_store.Frame as S17;
import nomo.session.recoverable_chat_store.Frame as S18;
import nomo.session.recoverable_chat_store.Evidence as S19;
import nomo.session.recoverable_followup_store.Frame as S20;
import nomo.session.recoverable_work_store.Frame as S21;
import nomo.session.recovery_decision.Decision as S22;
import nomo.session.store_record.Record as S23;
import nomo.session.work_chain_journal.Record as S24;
import nomo.session.work_chain.Record as S25;
import nomo.session.work_record.Record as S26;
import nomo.native.history.Session as S27;
import nomo.native.history.Event as S28;
import nomo.native.history.CopyJob as S29;
import nomo.domain.process.archived_jobs.ArchivedJob as S30;
import nomo.native.lifecycle.Attempt as S31;
import nomo.session.user_context_chain_v4_journal.Record as S32;
import nomo.session.user_context_chain_v4.Record as S33;

alias Schema0 = MemoryRegion<{
    Parsed: Store<string, S0>
}>;
public let Source0 = std.memory.region<Schema0>(
    stable_id = "nomo-native-configuration-v1",
    store = "native-configuration"
);

alias Schema1 = MemoryRegion<{
    Journals: Store<string, S1>,
    Steps: Store<string, S2>
}>;
public let Source1 = std.memory.region<Schema1>(
    stable_id = "nomo-native-file-journals-v1",
    store = "native-file-journals"
);

alias Schema2 = MemoryRegion<{
    Jobs: Store<string, S3>,
    Outputs: Store<string, S4>
}>;
public let Source2 = std.memory.region<Schema2>(
    stable_id = "nomo-native-processes-v1",
    store = "native-processes"
);

alias Schema3 = MemoryRegion<{
    Recent: Store<string, Array<string>>
}>;
public let Source3 = std.memory.region<Schema3>(
    stable_id = "nomo-native-projects-v1",
    store = "native-projects"
);

alias Schema4 = MemoryRegion<{
    Rows: Store<string, S5>
}>;
public let Source4 = std.memory.region<Schema4>(stable_id = "nomo-chat-history-v1", store = "chat-history");

alias Schema5 = MemoryRegion<{
    Rows: Store<string, S6>
}>;
public let Source5 = std.memory.region<Schema5>(stable_id = "nomo-chat-history-v3", store = "chat-history-v3");

alias Schema6 = MemoryRegion<{
    Rows: Store<string, S7>
}>;
public let Source6 = std.memory.region<Schema6>(stable_id = "nomo-check-output-v1", store = "check-output");

alias Schema7 = MemoryRegion<{
    Claims: Store<string, S8>
}>;
public let Source7 = std.memory.region<Schema7>(stable_id = "nomo-session-demo-v1", store = "session-demo");

alias Schema8 = MemoryRegion<{
    Rows: Store<string, S9>
}>;
public let Source8 = std.memory.region<Schema8>(
    stable_id = "nomo-continuous-work-v1",
    store = "continuous-work"
);

alias Schema9 = MemoryRegion<{
    Rows: Store<string, S10>
}>;
public let Source9 = std.memory.region<Schema9>(
    stable_id = "nomo-edit-operation-v1",
    store = "edit-operation"
);

alias Schema10 = MemoryRegion<{
    Rows: Store<string, S10>
}>;
public let Source10 = std.memory.region<Schema10>(
    stable_id = "nomo-edit-followup-v1",
    store = "edit-followup"
);

alias Schema11 = MemoryRegion<{
    Rows: Store<string, S11>
}>;
public let Source11 = std.memory.region<Schema11>(
    stable_id = "nomo-event-history-v1",
    store = "event-history"
);

alias Schema12 = MemoryRegion<{
    Rows: Store<string, S12>
}>;
public let Source12 = std.memory.region<Schema12>(
    stable_id = "nomo-harness-checkpoint-v1",
    store = "harness-checkpoint"
);

alias Schema13 = MemoryRegion<{
    Rows: Store<string, S13>
}>;
public let Source13 = std.memory.region<Schema13>(
    stable_id = "nomo-harness-successor-v1",
    store = "harness-successor"
);

alias Schema14 = MemoryRegion<{
    Rows: Store<string, S14>
}>;
public let Source14 = std.memory.region<Schema14>(
    stable_id = "nomo-history-check-v1",
    store = "history-check"
);

alias Schema15 = MemoryRegion<{
    Rows: Store<string, S14>
}>;
public let Source15 = std.memory.region<Schema15>(
    stable_id = "nomo-followup-check-v1",
    store = "followup-check"
);

alias Schema16 = MemoryRegion<{
    Rows: Store<string, S15>
}>;
public let Source16 = std.memory.region<Schema16>(stable_id = "nomo-history-work-v1", store = "history-work");

alias Schema17 = MemoryRegion<{
    Rows: Store<string, S16>
}>;
public let Source17 = std.memory.region<Schema17>(
    stable_id = "nomo-history-followup-v1",
    store = "history-followup"
);

alias Schema18 = MemoryRegion<{
    Rows: Store<string, S17>
}>;
public let Source18 = std.memory.region<Schema18>(
    stable_id = "nomo-recoverable-check-v1",
    store = "recoverable-check"
);

alias Schema19 = MemoryRegion<{
    Rows: Store<string, S18>
}>;
public let Source19 = std.memory.region<Schema19>(
    stable_id = "nomo-recoverable-chat-v1",
    store = "recoverable-chat"
);

alias Schema20 = MemoryRegion<{
    Rows: Store<string, S19>
}>;
public let Source20 = std.memory.region<Schema20>(
    stable_id = "nomo-recoverable-chat-evidence-v1",
    store = "recoverable-chat-evidence"
);

alias Schema21 = MemoryRegion<{
    Rows: Store<string, S17>
}>;
public let Source21 = std.memory.region<Schema21>(
    stable_id = "nomo-recoverable-followup-check-v1",
    store = "recoverable-followup-check"
);

alias Schema22 = MemoryRegion<{
    Rows: Store<string, S20>
}>;
public let Source22 = std.memory.region<Schema22>(
    stable_id = "nomo-recoverable-followup-v1",
    store = "recoverable-followup"
);

alias Schema23 = MemoryRegion<{
    Rows: Store<string, S21>
}>;
public let Source23 = std.memory.region<Schema23>(
    stable_id = "nomo-recoverable-work-v1",
    store = "recoverable-work"
);

alias Schema24 = MemoryRegion<{
    Rows: Store<string, S22>
}>;
public let Source24 = std.memory.region<Schema24>(
    stable_id = "nomo-recovery-decision-v1",
    store = "recovery-decision"
);

alias Schema25 = MemoryRegion<{
    Rows: Store<string, S23>
}>;
public let Source25 = std.memory.region<Schema25>(stable_id = "nomo-session-store-v1", store = "session");

alias Schema26 = MemoryRegion<{
    Rows: Store<string, S24>
}>;
public let Source26 = std.memory.region<Schema26>(
    stable_id = "nomo-work-chain-edit-v2",
    store = "work-chain-edit"
);

alias Schema27 = MemoryRegion<{
    Rows: Store<string, S25>
}>;
public let Source27 = std.memory.region<Schema27>(stable_id = "nomo-work-chain-v2", store = "work-chain");

alias Schema28 = MemoryRegion<{
    Rows: Store<string, S26>
}>;
public let Source28 = std.memory.region<Schema28>(stable_id = "nomo-work-record-v1", store = "work-record");

alias Schema29 = MemoryRegion<
    {
        Counters: Store<string, i64>,
        Selected: Store<string, string>,
        Sessions: Store<string, S27>,
        Events: Store<string, S28>,
        Chunks: Store<string, string>
    }
>;
public let Source29 = std.memory.region<Schema29>(
    stable_id = "nomo-native-conversations-v1",
    store = "native-conversations"
);

alias Schema30 = MemoryRegion<{
    Jobs: Store<string, S29>
}>;
public let Source30 = std.memory.region<Schema30>(
    stable_id = "nomo-native-conversation-copies-v1",
    store = "native-conversation-copies"
);

alias Schema31 = MemoryRegion<{
    Jobs: Store<string, S30>,
    Parts: Store<string, bytes>
}>;
public let Source31 = std.memory.region<Schema31>(
    stable_id = "nomo-native-project-jobs-v1",
    store = "native-project-jobs"
);

alias Schema32 = MemoryRegion<{
    Counter: Store<string, i64>,
    Attempts: Store<string, S31>
}>;
public let Source32 = std.memory.region<Schema32>(
    stable_id = "nomo-native-attempts-v1",
    store = "native-attempts"
);

alias Schema33 = MemoryRegion<{
    Rows: Store<string, S32>
}>;
public let Source33 = std.memory.region<Schema33>(
    stable_id = "nomo-user-context-edit-v4",
    store = "user-context-edit"
);

alias Schema34 = MemoryRegion<{
    Rows: Store<string, S33>
}>;
public let Source34 = std.memory.region<Schema34>(
    stable_id = "nomo-user-context-chain-v4",
    store = "user-context-chain"
);
