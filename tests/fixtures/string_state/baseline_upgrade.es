module app.baseline_upgrade;

import app.state_upgrade.{check_state, edit, reference, summary};
import nomo.domain.harness.loop.recorded_tool;
import nomo.domain.changes.JournalPhase as T0;
import nomo.domain.changes.FileJournal as T1;
import nomo.domain.changes.Journal as T2;
import nomo.domain.changes.StepPhase as T3;
import nomo.domain.changes.FileStep as T4;
import nomo.domain.changes.Step as T5;
import nomo.domain.processes.JobPhase as T6;
import nomo.domain.processes.ProcessJob as T7;
import nomo.domain.processes.Job as T8;
import nomo.domain.processes.JobEventKind as T9;
import nomo.domain.processes.ProcessOutput as T10;
import nomo.domain.processes.JobEvent as T11;
import nomo.domain.sessions.chat.ChatPhase as T12;
import nomo.domain.harness.chat.PriorRead as T13;
import nomo.domain.harness.chat.Previous as T14;
import nomo.domain.harness.chat.ReadInvocation as T15;
import nomo.domain.harness.chat.Invocation as T16;
import nomo.domain.sessions.chat.ChatSessionState as T17;
import nomo.domain.sessions.chat.ChatSession as T18;
import nomo.domain.conversation.TraceRole as T19;
import nomo.domain.conversation.TraceKind as T20;
import nomo.domain.conversation.TraceEvent as T21;
import nomo.domain.conversation.Event as T22;
import nomo.domain.sessions.chat.ChatHistorySnapshot as T23;
import nomo.domain.sessions.chat.ChatHistoryFrame as T24;
import nomo.domain.sessions.work.CheckSlot as T25;
import nomo.domain.sessions.work.CapturedCheckOutput as T26;
import nomo.domain.sessions.work.CheckOutputRecord as T27;
import nomo.domain.sessions.state.DemoClaimPhase as T28;
import nomo.domain.sessions.state.DemoSessionClaim as T29;
import nomo.domain.sessions.state.DemoClaim as T30;
import nomo.domain.sessions.work.ContinuousEdit as T31;
import nomo.domain.sessions.work.ContinuousEditState as T32;
import nomo.domain.sessions.work.WorkSummary as T33;
import nomo.domain.sessions.work.ContinuousResult as T34;
import nomo.domain.sessions.work.ContinuousCheckAttempt as T35;
import nomo.domain.sessions.work.ContinuousCheck as T36;
import nomo.domain.sessions.work.ContinuousWorkEntry as T37;
import nomo.domain.sessions.work.ContinuousEntry as T38;
import nomo.domain.sessions.work.ContinuousWorkHistory as T39;
import nomo.domain.sessions.work.ContinuousBook as T40;
import nomo.domain.editing.LiteralEditPhase as T41;
import nomo.domain.editing.LiteralEditRecord as T42;
import nomo.domain.editing.EditOperation as T43;
import nomo.domain.sessions.event_codec.RecordedTraceHistory as T44;
import nomo.domain.sessions.event_codec.History as T45;
import nomo.domain.sessions.checkpoints.CheckpointRecordPhase as T46;
import nomo.domain.sessions.checkpoints.StoredCheckpoint as T47;
import nomo.domain.sessions.checkpoints.CheckpointRecord as T48;
import nomo.domain.sessions.checkpoints.SuccessorRecordPhase as T49;
import nomo.domain.sessions.checkpoints.StoredSuccessor as T50;
import nomo.domain.sessions.checkpoints.SuccessorRecord as T51;
import nomo.domain.sessions.work.CheckAttempt as T52;
import nomo.domain.sessions.work.CheckRecord as T53;
import nomo.domain.sessions.work.WorkPhase as T54;
import nomo.domain.sessions.work.WorkAttempt as T55;
import nomo.domain.sessions.work.WorkRecord as T56;
import nomo.domain.sessions.work.FollowupPhase as T57;
import nomo.domain.sessions.work.FollowupPredecessor as T58;
import nomo.domain.sessions.work.FollowupParent as T59;
import nomo.domain.sessions.work.FollowupAttempt as T60;
import nomo.domain.sessions.work.FollowupRecord as T61;
import nomo.domain.sessions.work.CapturedCheckAttempt as T62;
import nomo.domain.sessions.work.CheckFrame as T63;
import nomo.domain.sessions.event_codec.TraceFrame as T64;
import nomo.domain.sessions.event_codec.EventFrame as T65;
import nomo.domain.sessions.chat.ChatSessionSnapshot as T66;
import nomo.domain.sessions.chat.RecoverableChatFrame as T67;
import nomo.domain.sessions.work.FollowupSessionFrame as T68;
import nomo.domain.sessions.work.RecoverableFollowupFrame as T69;
import nomo.domain.sessions.work.WorkSessionFrame as T70;
import nomo.domain.sessions.work.RecoverableWorkFrame as T71;
import nomo.domain.sessions.chain.RecoveryChoice as T72;
import nomo.domain.sessions.chain.RecordedRecovery as T73;
import nomo.domain.sessions.chain.RecoveryDecision as T74;
import nomo.domain.sessions.state.MetadataPhase as T75;
import nomo.domain.sessions.state.SessionMode as T76;
import nomo.domain.sessions.state.SessionLifecycle as T77;
import nomo.domain.conversation.TraceState as T78;
import nomo.domain.conversation.State as T79;
import nomo.domain.sessions.state.Reference as T80;
import nomo.domain.sessions.state.EventReference as T81;
import nomo.domain.sessions.state.OperationStatus as T82;
import nomo.domain.sessions.state.SessionOperation as T83;
import nomo.domain.sessions.state.Operation as T84;
import nomo.domain.sessions.state.SessionSnapshot as T85;
import nomo.domain.sessions.state.Snapshot as T86;
import nomo.domain.sessions.state.StoredSessionMetadata as T87;
import nomo.domain.sessions.state.MetadataRecord as T88;
import nomo.domain.sessions.chain.ChainEditPhase as T89;
import nomo.domain.sessions.chain.ChainEditJournal as T90;
import nomo.domain.sessions.chain.EditJournalRecord as T91;
import nomo.domain.sessions.chain.ChainPhase as T92;
import nomo.domain.sessions.work.StoredWorkPhase as T93;
import nomo.domain.sessions.work.CapturedWork as T94;
import nomo.domain.sessions.work.StoredWorkRecord as T95;
import nomo.domain.sessions.chain.WorkChain as T96;
import nomo.domain.sessions.chain.Record as T97;
import nomo.domain.archives.CopyKind as T98;
import nomo.domain.archives.CopyPhase as T99;
import nomo.domain.archives.ConversationCopy as T100;
import nomo.domain.archives.CopyJob as T101;
import nomo.domain.processes.ArchivedJobPhase as T102;
import nomo.domain.processes.ArchivedProcessJob as T103;
import nomo.domain.processes.ArchivedJob as T104;
import nomo.domain.attempts.AttemptKind as T105;
import nomo.domain.attempts.AttemptPhase as T106;
import nomo.domain.attempts.ExecutionAttempt as T107;
import nomo.domain.attempts.Attempt as T108;
import nomo.domain.sessions.user_context_chain_v4.RootBoundChainJournal as T109;
import nomo.domain.sessions.user_context_chain_v4.JournalRecord as T110;
import nomo.domain.sessions.user_context_chain_v4.RootBoundWorkChain as T111;
import nomo.domain.sessions.user_context_chain_v4.Record as T112;

public flow upgrade_0(value: T2) -> T1 ![] {
    return T1 {
        id = value.id,
        session = value.session,
        name = value.name,
        call = value.call,
        phase = T0.parse(value.phase),
        steps = value.steps,
        message = value.message,
        owner_call = value.owner_call,
        owner_name = value.owner_name
    };
}

public flow upgrade_1(value: T5) -> T4 ![] {
    return T4 {
        phase = T3.parse(value.phase),
        paths = value.paths
    };
}

public flow upgrade_2(value: T8) -> T7 ![] {
    return T7 {
        id = value.id,
        session = value.session,
        program = value.program,
        arguments = value.arguments,
        handle = value.handle,
        phase = T6.parse(value.phase)
    };
}

public flow upgrade_3(value: T11) -> T10 ![] {
    return T10 {
        job = value.job,
        call = value.call,
        phase = T9.parse(value.phase),
        exit_code = value.exit_code,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_bytes = value.stdout_bytes,
        stderr_bytes = value.stderr_bytes
    };
}

public flow upgrade_4(value: T18) -> T17 ![] {
    return T17 {
        format = value.format,
        phase = T12.parse(value.phase),
        invocation = upgrade_5(value.invocation),
        last_request = value.last_request,
        pending = value.pending
    };
}

public flow upgrade_5(value: T16) -> T15 ![] {
    return T15 {
        usage = value.usage,
        maximum = value.maximum,
        admitted = value.admitted,
        prior = upgrade_6(value.prior)
    };
}

public flow upgrade_6(value: T14) -> T13 ![] {
    return T13 {
        task = value.task,
        result = value.result,
        tool = recorded_tool(value.tool),
        outcome = value.outcome,
        answer = value.answer
    };
}

public flow upgrade_7(value: T24) -> T23 ![] {
    return T23 {
        format = value.format,
        chat = upgrade_4(value.chat),
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_8(item)).collect()
    };
}

public flow upgrade_8(value: T22) -> T21 ![] {
    return T21 {
        role = T19.parse(value.role),
        kind = T20.parse(value.kind),
        name = value.name,
        text = value.text
    };
}

public flow upgrade_9(value: T27) -> T26 ![] {
    return T26 {
        format = value.format,
        slot = T25.parse(value.slot),
        id = value.id,
        digest = value.digest,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_10(value: T30) -> T29 ![] {
    return T29 {
        format = value.format,
        phase = T28.parse(value.phase),
        session_id = value.session_id,
        save_id = value.save_id,
        binding = value.binding,
        maximum = value.maximum,
        budget = value.budget
    };
}

public flow upgrade_11(value: T40) -> T39 ![] {
    return T39 {
        binding = value.binding,
        history = value.history.iter().map(item => upgrade_12(item)).collect(),
        current = upgrade_12(value.current)
    };
}

public flow upgrade_12(value: T38) -> T37 ![] {
    return T37 {
        core = value.core,
        edit = upgrade_13(value.edit),
        result = upgrade_14(value.result),
        check = upgrade_15(value.check)
    };
}

public flow upgrade_13(value: T31) -> T32 ![] {
    return edit(value.phase, value.binding);
}

public flow upgrade_14(value: T34) -> T33 ![] {
    return T33 {
        phase = summary(value.phase, value.source),
        summary = value.summary,
        calls = value.calls,
        generation = value.generation,
        events = value.events.iter().map(item => upgrade_8(item)).collect()
    };
}

public flow upgrade_15(value: T36) -> T35 ![] {
    return T35 {
        phase = check_state(value.phase, value.outcome, value.exit_code),
        digest = value.digest,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_16(value: T43) -> T42 ![] {
    return T42 {
        format = value.format,
        phase = T41.parse(value.phase),
        binding = value.binding
    };
}

public flow upgrade_17(value: T45) -> T44 ![] {
    return T44 {
        format = value.format,
        turns = value.turns,
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_8(item)).collect()
    };
}

public flow upgrade_18(value: T48) -> T47 ![] {
    return T47 {
        format = value.format,
        phase = T46.parse(value.phase),
        identity = value.identity,
        body = value.body
    };
}

public flow upgrade_19(value: T51) -> T50 ![] {
    return T50 {
        format = value.format,
        phase = T49.parse(value.phase),
        predecessor = value.predecessor,
        successor = value.successor,
        predecessor_version = value.predecessor_version,
        predecessor_body = value.predecessor_body,
        request = value.request,
        body = value.body,
        usage = value.usage,
        maximum = value.maximum,
        reserved = value.reserved,
        admitted = value.admitted,
        resolved = value.resolved
    };
}

public flow upgrade_20(value: T53) -> T52 ![] {
    return T52 {
        format = value.format,
        phase = check_state(value.phase, value.outcome, value.exit_code),
        id = value.id,
        digest = value.digest
    };
}

public flow upgrade_21(value: T56) -> T55 ![] {
    return T55 {
        format = value.format,
        phase = T54.parse(value.phase),
        id = value.id,
        workspace = value.workspace,
        path = value.path,
        request = value.request,
        history_version = value.history_version,
        reserved = value.reserved,
        settled = value.settled,
        summary = value.summary
    };
}

public flow upgrade_22(value: T61) -> T60 ![] {
    return T60 {
        format = value.format,
        phase = T57.parse(value.phase),
        id = value.id,
        workspace = value.workspace,
        path = value.path,
        request = value.request,
        history_version = value.history_version,
        parent = upgrade_23(value.parent),
        reserved = value.reserved,
        settled = value.settled,
        summary = value.summary
    };
}

public flow upgrade_23(value: T59) -> T58 ![] {
    return T58 {
        work = upgrade_21(value.work),
        edit = upgrade_16(value.edit),
        check = value.check.map(item => upgrade_20(item))
    };
}

public flow upgrade_24(value: T63) -> T62 ![] {
    return T62 {
        format = value.format,
        policy_binding = value.policy_binding,
        work_history = value.work_history,
        workspace = value.workspace,
        path = value.path,
        check = upgrade_20(value.check),
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_25(value: T67) -> T66 ![] {
    return T66 {
        format = value.format,
        encoding = value.encoding,
        policy_binding = value.policy_binding,
        chat = upgrade_4(value.chat),
        events = upgrade_26(value.events)
    };
}

public flow upgrade_26(value: T65) -> T64 ![] {
    return T64 {
        format = value.format,
        turns = value.turns,
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_8(item)).collect()
    };
}

public flow upgrade_27(value: T69) -> T68 ![] {
    return T68 {
        format = value.format,
        policy_binding = value.policy_binding,
        parent_work_version = value.parent_work_version,
        parent_check_version = value.parent_check_version,
        work = upgrade_21(value.work),
        events = upgrade_26(value.events)
    };
}

public flow upgrade_28(value: T71) -> T70 ![] {
    return T70 {
        format = value.format,
        policy_binding = value.policy_binding,
        work = upgrade_21(value.work),
        events = upgrade_26(value.events)
    };
}

public flow upgrade_29(value: T74) -> T73 ![] {
    return T73 {
        format = value.format,
        id = value.id,
        target = value.target,
        choice = T72.parse(value.choice)
    };
}

public flow upgrade_30(value: T88) -> T87 ![] {
    return T87 {
        format = value.format,
        phase = T75.parse(value.phase),
        save_id = value.save_id,
        session_key = value.session_key,
        snapshot = upgrade_31(value.snapshot)
    };
}

public flow upgrade_31(value: T86) -> T85 ![] {
    return T85 {
        format = value.format,
        session_id = value.session_id,
        generation = value.generation,
        mode = T76.parse(value.mode),
        binding = value.binding,
        lifecycle = T77.parse(value.lifecycle),
        history = upgrade_32(value.history),
        references = value.references.iter().map(item => upgrade_33(item)).collect(),
        operations = value.operations.iter().map(item => upgrade_34(item)).collect(),
        original_caps = value.original_caps,
        current_caps = value.current_caps,
        ledger = value.ledger
    };
}

public flow upgrade_32(value: T79) -> T78 ![] {
    return T78 {
        events = value.events.iter().map(item => upgrade_8(item)).collect(),
        characters = value.characters,
        spent = value.spent,
        stopped = value.stopped
    };
}

public flow upgrade_33(value: T80) -> T81 ![] {
    return reference(value.operation, value.phase);
}

public flow upgrade_34(value: T84) -> T83 ![] {
    return T83 {
        id = value.id,
        status = T82.parse(value.status),
        attempts = value.attempts,
        tokens = value.tokens,
        scan_bytes = value.scan_bytes
    };
}

public flow upgrade_35(value: T91) -> T90 ![] {
    return T90 {
        format = value.format,
        chain = value.chain,
        turn = value.turn,
        phase = T89.parse(value.phase),
        binding = value.binding
    };
}

public flow upgrade_36(value: T97) -> T96 ![] {
    return T96 {
        format = value.format,
        phase = T92.parse(value.phase),
        chain = value.chain,
        turn = value.turn,
        id = value.id,
        workspace = value.workspace,
        region = value.region,
        path = value.path,
        request = value.request,
        allowed = value.allowed,
        parent_id = value.parent_id,
        parent_version = value.parent_version,
        parent_digest = value.parent_digest,
        maximum = value.maximum,
        available = value.available,
        remaining = value.remaining,
        reserved = value.reserved,
        work = value.work.map(item => upgrade_37(item))
    };
}

public flow upgrade_37(value: T95) -> T94 ![] {
    return T94 {
        format = value.format,
        phase = T93.parse(value.phase),
        binding = value.binding,
        body = value.body
    };
}

public flow upgrade_38(value: T101) -> T100 ![] {
    return T100 {
        id = value.id,
        workspace = value.workspace,
        title = value.title,
        kind = T98.parse(value.kind),
        source = value.source,
        digest = value.digest,
        total = value.total,
        cursor = value.cursor,
        phase = T99.parse(value.phase)
    };
}

public flow upgrade_39(value: T104) -> T103 ![] {
    return T103 {
        id = value.id,
        workspace = value.workspace,
        arguments = value.arguments,
        phase = T102.parse(value.phase),
        exit_code = value.exit_code,
        output_bytes = value.output_bytes,
        parts = value.parts,
        original = value.original
    };
}

public flow upgrade_40(value: T108) -> T107 ![] {
    return T107 {
        id = value.id,
        session = value.session,
        kind = T105.parse(value.kind),
        label = value.label,
        phase = T106.parse(value.phase),
        input_event = value.input_event,
        through = value.through,
        result_event = value.result_event,
        recovery_event = value.recovery_event
    };
}

public flow upgrade_41(value: T110) -> T109 ![] {
    return T109 {
        format = value.format,
        chain = value.chain,
        turn = value.turn,
        phase = T89.parse(value.phase),
        root = value.root,
        binding = value.binding
    };
}

public flow upgrade_42(value: T112) -> T111 ![] {
    return T111 {
        format = value.format,
        root = value.root,
        parent_proof = value.parent_proof,
        base = upgrade_36(value.base)
    };
}
