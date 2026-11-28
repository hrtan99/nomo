module app.historical_upgrade;

import app.state_upgrade.{check_state, edit, reference, summary};
import nomo.domain.harness.loop.recorded_tool;
import nomo.domain.settings.CachedConfiguration as T0;
import nomo.native.configuration.Cached as T1;
import nomo.domain.changes.JournalPhase as T2;
import nomo.domain.changes.FileJournal as T3;
import nomo.native.mutations.Journal as T4;
import nomo.domain.changes.StepPhase as T5;
import nomo.domain.changes.SavedPath as T6;
import nomo.native.mutations.SavedPath as T7;
import nomo.domain.changes.FileStep as T8;
import nomo.native.mutations.Step as T9;
import nomo.domain.processes.JobPhase as T10;
import nomo.domain.processes.ProcessJob as T11;
import nomo.native.processes.Job as T12;
import nomo.domain.processes.JobEventKind as T13;
import nomo.domain.processes.ProcessOutput as T14;
import nomo.native.processes.JobEvent as T15;
import nomo.domain.sessions.chat.ChatPhase as T16;
import nomo.domain.harness.loop.ReadLedger as T17;
import nomo.harness.harness_tool_contract.Ledger as T18;
import nomo.domain.harness.chat.PriorRead as T19;
import nomo.harness.harness_tool_chat_contract.Previous as T20;
import nomo.domain.harness.chat.ReadInvocation as T21;
import nomo.harness.harness_tool_chat_contract.Invocation as T22;
import nomo.domain.sessions.chat.ChatSessionState as T23;
import nomo.session.chat_session_contract.Session as T24;
import nomo.domain.conversation.TraceRole as T25;
import nomo.domain.conversation.TraceKind as T26;
import nomo.domain.conversation.TraceEvent as T27;
import nomo.core.conversation.Event as T28;
import nomo.domain.sessions.chat.ChatHistorySnapshot as T29;
import nomo.session.chat_history.Frame as T30;
import nomo.domain.sessions.work.CheckSlot as T31;
import nomo.domain.sessions.work.CapturedCheckOutput as T32;
import nomo.session.check_output.Record as T33;
import nomo.domain.sessions.state.DemoClaimPhase as T34;
import nomo.domain.sessions.state.DemoSessionClaim as T35;
import nomo.session.demo_claim.Claim as T36;
import nomo.domain.sessions.work.ContinuousCore as T37;
import nomo.session.continuous_work.Core as T38;
import nomo.domain.editing.Binding as T39;
import nomo.session.edit_operation.Binding as T40;
import nomo.session.continuous_work.Edit as T41;
import nomo.domain.sessions.work.ContinuousEditState as T42;
import nomo.domain.sessions.work.WorkSummary as T43;
import nomo.session.continuous_work.ResultData as T44;
import nomo.domain.sessions.work.ContinuousCheckAttempt as T45;
import nomo.session.continuous_work.Check as T46;
import nomo.domain.sessions.work.ContinuousWorkEntry as T47;
import nomo.session.continuous_work.Entry as T48;
import nomo.domain.sessions.work.ContinuousWorkHistory as T49;
import nomo.session.continuous_work.Book as T50;
import nomo.domain.editing.LiteralEditPhase as T51;
import nomo.domain.editing.LiteralEditRecord as T52;
import nomo.session.edit_operation.Record as T53;
import nomo.domain.sessions.event_codec.RecordedTraceHistory as T54;
import nomo.session.event_history.History as T55;
import nomo.domain.sessions.checkpoints.CheckpointRecordPhase as T56;
import nomo.domain.sessions.checkpoints.Identity as T57;
import nomo.session.harness_checkpoint.Identity as T58;
import nomo.domain.sessions.checkpoints.StoredCheckpoint as T59;
import nomo.session.harness_checkpoint_store.Record as T60;
import nomo.domain.sessions.checkpoints.SuccessorRecordPhase as T61;
import nomo.domain.sessions.checkpoints.StoredSuccessor as T62;
import nomo.session.harness_successor_store.Record as T63;
import nomo.domain.sessions.work.CheckAttempt as T64;
import nomo.session.history_check_store.Record as T65;
import nomo.domain.sessions.work.WorkPhase as T66;
import nomo.domain.sessions.work.WorkBudget as T67;
import nomo.session.history_work_guard.Budget as T68;
import nomo.domain.harness.edit.EditLedger as T69;
import nomo.harness.harness_edit_contract.Ledger as T70;
import nomo.domain.harness.work.WorkLedger as T71;
import nomo.harness.harness_work_contract.Ledger as T72;
import nomo.domain.sessions.work.WorkAttempt as T73;
import nomo.session.history_work_guard.Record as T74;
import nomo.domain.sessions.work.FollowupPhase as T75;
import nomo.domain.sessions.work.FollowupPredecessor as T76;
import nomo.session.history_followup_guard.Parent as T77;
import nomo.domain.sessions.work.FollowupBudget as T78;
import nomo.session.history_followup_guard.Budget as T79;
import nomo.domain.sessions.work.FollowupAttempt as T80;
import nomo.session.history_followup_guard.Record as T81;
import nomo.domain.sessions.work.CapturedCheckAttempt as T82;
import nomo.session.check_store.Frame as T83;
import nomo.domain.sessions.event_codec.TraceFrame as T84;
import nomo.session.recoverable_events.Frame as T85;
import nomo.domain.sessions.chat.ChatSessionSnapshot as T86;
import nomo.session.recoverable_chat_store.Frame as T87;
import nomo.domain.sessions.chat.ChatEvidence as T88;
import nomo.session.recoverable_chat_store.Evidence as T89;
import nomo.domain.sessions.work.FollowupSessionFrame as T90;
import nomo.session.recoverable_followup_store.Frame as T91;
import nomo.domain.sessions.work.WorkSessionFrame as T92;
import nomo.session.recoverable_work_store.Frame as T93;
import nomo.domain.sessions.chain.RecoveryChoice as T94;
import nomo.domain.sessions.chain.RecordedRecovery as T95;
import nomo.session.recovery_decision.Decision as T96;
import nomo.domain.sessions.state.MetadataPhase as T97;
import nomo.domain.sessions.state.SessionMode as T98;
import nomo.domain.sessions.state.SessionLifecycle as T99;
import nomo.domain.conversation.TraceState as T100;
import nomo.core.conversation.State as T101;
import nomo.session.session_state.Reference as T102;
import nomo.domain.sessions.state.EventReference as T103;
import nomo.domain.sessions.state.OperationStatus as T104;
import nomo.domain.sessions.state.SessionOperation as T105;
import nomo.session.session_state.Operation as T106;
import nomo.domain.sessions.state.Caps as T107;
import nomo.session.session_state.Caps as T108;
import nomo.domain.sessions.state.Ledger as T109;
import nomo.session.session_state.Ledger as T110;
import nomo.domain.sessions.state.SessionSnapshot as T111;
import nomo.session.session_state.Snapshot as T112;
import nomo.domain.sessions.state.StoredSessionMetadata as T113;
import nomo.session.store_record.Record as T114;
import nomo.domain.sessions.chain.ChainEditPhase as T115;
import nomo.domain.sessions.chain.ChainEditJournal as T116;
import nomo.session.work_chain_journal.Record as T117;
import nomo.domain.sessions.chain.ChainPhase as T118;
import nomo.domain.sessions.chain.Caps as T119;
import nomo.session.work_chain.Caps as T120;
import nomo.domain.sessions.work.StoredWorkPhase as T121;
import nomo.domain.sessions.work.CapturedWork as T122;
import nomo.session.work_record.Record as T123;
import nomo.domain.sessions.chain.WorkChain as T124;
import nomo.session.work_chain.Record as T125;
import nomo.domain.conversation.ConversationLedger as T126;
import nomo.native.history.Ledger as T127;
import nomo.domain.conversation.SavedSession as T128;
import nomo.native.history.Session as T129;
import nomo.domain.conversation.StoredEvent as T130;
import nomo.native.history.Event as T131;
import nomo.domain.archives.CopyKind as T132;
import nomo.domain.archives.CopyPhase as T133;
import nomo.domain.archives.ConversationCopy as T134;
import nomo.native.history.CopyJob as T135;
import nomo.domain.processes.ArchivedJobPhase as T136;
import nomo.domain.processes.ArchivedProcessJob as T137;
import nomo.domain.process.archived_jobs.ArchivedJob as T138;
import nomo.domain.attempts.AttemptKind as T139;
import nomo.domain.attempts.AttemptPhase as T140;
import nomo.domain.attempts.ExecutionAttempt as T141;
import nomo.native.lifecycle.Attempt as T142;
import nomo.domain.sessions.user_context_chain_v4.RootIdentity as T143;
import nomo.session.user_context_chain_v4.RootIdentity as T144;
import nomo.domain.sessions.user_context_chain_v4.RootBoundChainJournal as T145;
import nomo.session.user_context_chain_v4_journal.Record as T146;
import nomo.domain.sessions.user_context_chain_v4.RootBoundWorkChain as T147;
import nomo.session.user_context_chain_v4.Record as T148;

public flow upgrade_0(value: T1) -> T0 ![] {
    return T0 {
        digest = value.digest,
        session = value.session,
        result_event = value.result_event
    };
}

public flow upgrade_1(value: T4) -> T3 ![] {
    return T3 {
        id = value.id,
        session = value.session,
        name = value.name,
        call = value.call,
        phase = T2.parse(value.phase),
        steps = value.steps,
        message = value.message,
        owner_call = value.owner_call,
        owner_name = value.owner_name
    };
}

public flow upgrade_2(value: T9) -> T8 ![] {
    return T8 {
        phase = T5.parse(value.phase),
        paths = value.paths.iter().map(item => upgrade_3(item)).collect()
    };
}

public flow upgrade_3(value: T7) -> T6 ![] {
    return T6 {
        path = value.path,
        before_exists = value.before_exists,
        before = value.before,
        after_exists = value.after_exists,
        after = value.after
    };
}

public flow upgrade_4(value: T12) -> T11 ![] {
    return T11 {
        id = value.id,
        session = value.session,
        program = value.program,
        arguments = value.arguments,
        handle = value.handle,
        phase = T10.parse(value.phase)
    };
}

public flow upgrade_5(value: T15) -> T14 ![] {
    return T14 {
        job = value.job,
        call = value.call,
        phase = T13.parse(value.phase),
        exit_code = value.exit_code,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_bytes = value.stdout_bytes,
        stderr_bytes = value.stderr_bytes
    };
}

public flow upgrade_6(value: T24) -> T23 ![] {
    return T23 {
        format = value.format,
        phase = T16.parse(value.phase),
        invocation = upgrade_7(value.invocation),
        last_request = value.last_request,
        pending = value.pending
    };
}

public flow upgrade_7(value: T22) -> T21 ![] {
    return T21 {
        usage = upgrade_8(value.usage),
        maximum = upgrade_8(value.maximum),
        admitted = value.admitted,
        prior = upgrade_9(value.prior)
    };
}

public flow upgrade_8(value: T18) -> T17 ![] {
    return T17 {
        steps = value.steps,
        calls = value.calls,
        tokens = value.tokens,
        tools = value.tools,
        scan = value.scan
    };
}

public flow upgrade_9(value: T20) -> T19 ![] {
    return T19 {
        task = value.task,
        result = value.result,
        tool = recorded_tool(value.tool),
        outcome = value.outcome,
        answer = value.answer
    };
}

public flow upgrade_10(value: T30) -> T29 ![] {
    return T29 {
        format = value.format,
        chat = upgrade_6(value.chat),
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_11(item)).collect()
    };
}

public flow upgrade_11(value: T28) -> T27 ![] {
    return T27 {
        role = T25.parse(value.role),
        kind = T26.parse(value.kind),
        name = value.name,
        text = value.text
    };
}

public flow upgrade_12(value: T33) -> T32 ![] {
    return T32 {
        format = value.format,
        slot = T31.parse(value.slot),
        id = value.id,
        digest = value.digest,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_13(value: T36) -> T35 ![] {
    return T35 {
        format = value.format,
        phase = T34.parse(value.phase),
        session_id = value.session_id,
        save_id = value.save_id,
        binding = value.binding,
        maximum = value.maximum,
        budget = value.budget
    };
}

public flow upgrade_14(value: T50) -> T49 ![] {
    return T49 {
        binding = value.binding,
        history = value.history.iter().map(item => upgrade_15(item)).collect(),
        current = upgrade_15(value.current)
    };
}

public flow upgrade_15(value: T48) -> T47 ![] {
    return T47 {
        core = upgrade_16(value.core),
        edit = upgrade_17(value.edit),
        result = upgrade_19(value.result),
        check = upgrade_20(value.check)
    };
}

public flow upgrade_16(value: T38) -> T37 ![] {
    return T37 {
        id = value.id,
        request = value.request
    };
}

public flow upgrade_17(value: T41) -> T42 ![] {
    return edit(value.phase, value.binding.map(item => upgrade_18(item)));
}

public flow upgrade_18(value: T40) -> T39 ![] {
    return T39 {
        id = value.id,
        workspace = value.workspace,
        region = value.region,
        path = value.path,
        request_digest = value.request_digest,
        before_digest = value.before_digest,
        after_digest = value.after_digest,
        before_bytes = value.before_bytes,
        after_bytes = value.after_bytes
    };
}

public flow upgrade_19(value: T44) -> T43 ![] {
    return T43 {
        phase = summary(value.phase, value.source),
        summary = value.summary,
        calls = value.calls,
        generation = value.generation,
        events = value.events.iter().map(item => upgrade_11(item)).collect()
    };
}

public flow upgrade_20(value: T46) -> T45 ![] {
    return T45 {
        phase = check_state(value.phase, value.outcome, value.exit_code),
        digest = value.digest,
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_21(value: T53) -> T52 ![] {
    return T52 {
        format = value.format,
        phase = T51.parse(value.phase),
        binding = upgrade_18(value.binding)
    };
}

public flow upgrade_22(value: T55) -> T54 ![] {
    return T54 {
        format = value.format,
        turns = value.turns,
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_11(item)).collect()
    };
}

public flow upgrade_23(value: T60) -> T59 ![] {
    return T59 {
        format = value.format,
        phase = T56.parse(value.phase),
        identity = upgrade_24(value.identity),
        body = value.body
    };
}

public flow upgrade_24(value: T58) -> T57 ![] {
    return T57 {
        id = value.id,
        workspace = value.workspace,
        allowed = value.allowed
    };
}

public flow upgrade_25(value: T63) -> T62 ![] {
    return T62 {
        format = value.format,
        phase = T61.parse(value.phase),
        predecessor = upgrade_24(value.predecessor),
        successor = upgrade_24(value.successor),
        predecessor_version = value.predecessor_version,
        predecessor_body = value.predecessor_body,
        request = value.request,
        body = value.body,
        usage = upgrade_8(value.usage),
        maximum = upgrade_8(value.maximum),
        reserved = upgrade_8(value.reserved),
        admitted = value.admitted,
        resolved = value.resolved
    };
}

public flow upgrade_26(value: T65) -> T64 ![] {
    return T64 {
        format = value.format,
        phase = check_state(value.phase, value.outcome, value.exit_code),
        id = value.id,
        digest = value.digest
    };
}

public flow upgrade_27(value: T74) -> T73 ![] {
    return T73 {
        format = value.format,
        phase = T66.parse(value.phase),
        id = value.id,
        workspace = value.workspace,
        path = value.path,
        request = value.request,
        history_version = value.history_version,
        reserved = upgrade_28(value.reserved),
        settled = value.settled.map(item => upgrade_29(item)),
        summary = value.summary
    };
}

public flow upgrade_28(value: T68) -> T67 ![] {
    return T67 {
        steps = value.steps,
        calls = value.calls,
        generation = value.generation,
        native_tokens = value.native_tokens
    };
}

public flow upgrade_29(value: T72) -> T71 ![] {
    return T71 {
        read = upgrade_8(value.read),
        edit = upgrade_30(value.edit)
    };
}

public flow upgrade_30(value: T70) -> T69 ![] {
    return T69 {
        steps = value.steps,
        calls = value.calls,
        tokens = value.tokens,
        native_tokens = value.native_tokens,
        boundaries = value.boundaries
    };
}

public flow upgrade_31(value: T81) -> T80 ![] {
    return T80 {
        format = value.format,
        phase = T75.parse(value.phase),
        id = value.id,
        workspace = value.workspace,
        path = value.path,
        request = value.request,
        history_version = value.history_version,
        parent = upgrade_32(value.parent),
        reserved = upgrade_33(value.reserved),
        settled = value.settled.map(item => upgrade_29(item)),
        summary = value.summary
    };
}

public flow upgrade_32(value: T77) -> T76 ![] {
    return T76 {
        work = upgrade_27(value.work),
        edit = upgrade_21(value.edit),
        check = value.check.map(item => upgrade_26(item))
    };
}

public flow upgrade_33(value: T79) -> T78 ![] {
    return T78 {
        steps = value.steps,
        calls = value.calls,
        generation = value.generation,
        native_tokens = value.native_tokens
    };
}

public flow upgrade_34(value: T83) -> T82 ![] {
    return T82 {
        format = value.format,
        policy_binding = value.policy_binding,
        work_history = value.work_history,
        workspace = value.workspace,
        path = value.path,
        check = upgrade_26(value.check),
        stdout = value.stdout,
        stderr = value.stderr,
        stdout_truncated = value.stdout_truncated,
        stderr_truncated = value.stderr_truncated
    };
}

public flow upgrade_35(value: T87) -> T86 ![] {
    return T86 {
        format = value.format,
        encoding = value.encoding,
        policy_binding = value.policy_binding,
        chat = upgrade_6(value.chat),
        events = upgrade_36(value.events)
    };
}

public flow upgrade_36(value: T85) -> T84 ![] {
    return T84 {
        format = value.format,
        turns = value.turns,
        first_count = value.first_count,
        events = value.events.iter().map(item => upgrade_11(item)).collect()
    };
}

public flow upgrade_37(value: T89) -> T88 ![] {
    return T88 {
        format = value.format,
        policy_binding = value.policy_binding,
        turn = value.turn,
        text = value.text
    };
}

public flow upgrade_38(value: T91) -> T90 ![] {
    return T90 {
        format = value.format,
        policy_binding = value.policy_binding,
        parent_work_version = value.parent_work_version,
        parent_check_version = value.parent_check_version,
        work = upgrade_27(value.work),
        events = upgrade_36(value.events)
    };
}

public flow upgrade_39(value: T93) -> T92 ![] {
    return T92 {
        format = value.format,
        policy_binding = value.policy_binding,
        work = upgrade_27(value.work),
        events = upgrade_36(value.events)
    };
}

public flow upgrade_40(value: T96) -> T95 ![] {
    return T95 {
        format = value.format,
        id = value.id,
        target = value.target,
        choice = T94.parse(value.choice)
    };
}

public flow upgrade_41(value: T114) -> T113 ![] {
    return T113 {
        format = value.format,
        phase = T97.parse(value.phase),
        save_id = value.save_id,
        session_key = value.session_key,
        snapshot = upgrade_42(value.snapshot)
    };
}

public flow upgrade_42(value: T112) -> T111 ![] {
    return T111 {
        format = value.format,
        session_id = value.session_id,
        generation = value.generation,
        mode = T98.parse(value.mode),
        binding = value.binding,
        lifecycle = T99.parse(value.lifecycle),
        history = upgrade_43(value.history),
        references = value.references.iter().map(item => upgrade_44(item)).collect(),
        operations = value.operations.iter().map(item => upgrade_45(item)).collect(),
        original_caps = upgrade_46(value.original_caps),
        current_caps = upgrade_46(value.current_caps),
        ledger = upgrade_47(value.ledger)
    };
}

public flow upgrade_43(value: T101) -> T100 ![] {
    return T100 {
        events = value.events.iter().map(item => upgrade_11(item)).collect(),
        characters = value.characters,
        spent = value.spent,
        stopped = value.stopped
    };
}

public flow upgrade_44(value: T102) -> T103 ![] {
    return reference(value.operation, value.phase);
}

public flow upgrade_45(value: T106) -> T105 ![] {
    return T105 {
        id = value.id,
        status = T104.parse(value.status),
        attempts = value.attempts,
        tokens = value.tokens,
        scan_bytes = value.scan_bytes
    };
}

public flow upgrade_46(value: T108) -> T107 ![] {
    return T107 {
        steps = value.steps,
        turn_steps = value.turn_steps,
        attempts = value.attempts,
        tokens = value.tokens,
        scan_bytes = value.scan_bytes
    };
}

public flow upgrade_47(value: T110) -> T109 ![] {
    return T109 {
        attempts = value.attempts,
        tokens = value.tokens,
        scan_bytes = value.scan_bytes,
        step_unit = value.step_unit,
        attempt_unit = value.attempt_unit,
        token_unit = value.token_unit,
        scan_unit = value.scan_unit
    };
}

public flow upgrade_48(value: T117) -> T116 ![] {
    return T116 {
        format = value.format,
        chain = value.chain,
        turn = value.turn,
        phase = T115.parse(value.phase),
        binding = upgrade_18(value.binding)
    };
}

public flow upgrade_49(value: T125) -> T124 ![] {
    return T124 {
        format = value.format,
        phase = T118.parse(value.phase),
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
        maximum = upgrade_50(value.maximum),
        available = upgrade_50(value.available),
        remaining = upgrade_50(value.remaining),
        reserved = upgrade_50(value.reserved),
        work = value.work.map(item => upgrade_51(item))
    };
}

public flow upgrade_50(value: T120) -> T119 ![] {
    return T119 {
        steps = value.steps,
        calls = value.calls,
        generation = value.generation,
        native_tokens = value.native_tokens,
        read_tools = value.read_tools,
        scan = value.scan,
        edit_reads = value.edit_reads,
        edit_read_bytes = value.edit_read_bytes,
        atomic = value.atomic,
        atomic_bytes = value.atomic_bytes
    };
}

public flow upgrade_51(value: T123) -> T122 ![] {
    return T122 {
        format = value.format,
        phase = T121.parse(value.phase),
        binding = upgrade_18(value.binding),
        body = value.body
    };
}

public flow upgrade_52(value: T129) -> T128 ![] {
    return T128 {
        id = value.id,
        workspace = value.workspace,
        title = value.title,
        next_event = value.next_event,
        first_user = value.first_user,
        summary_event = value.summary_event,
        summary_through = value.summary_through,
        pending = value.pending,
        ledger = upgrade_53(value.ledger)
    };
}

public flow upgrade_53(value: T127) -> T126 ![] {
    return T126 {
        turns = value.turns,
        compactions = value.compactions,
        tools = value.tools,
        generation_allowance = value.generation_allowance,
        context_bytes = value.context_bytes
    };
}

public flow upgrade_54(value: T131) -> T130 ![] {
    return T130 {
        role = value.role,
        name = value.name,
        call = value.call,
        chunks = value.chunks,
        complete = value.complete
    };
}

public flow upgrade_55(value: T135) -> T134 ![] {
    return T134 {
        id = value.id,
        workspace = value.workspace,
        title = value.title,
        kind = T132.parse(value.kind),
        source = value.source,
        digest = value.digest,
        total = value.total,
        cursor = value.cursor,
        phase = T133.parse(value.phase)
    };
}

public flow upgrade_56(value: T138) -> T137 ![] {
    return T137 {
        id = value.id,
        workspace = value.workspace,
        arguments = value.arguments,
        phase = T136.parse(value.phase),
        exit_code = value.exit_code,
        output_bytes = value.output_bytes,
        parts = value.parts,
        original = value.original
    };
}

public flow upgrade_57(value: T142) -> T141 ![] {
    return T141 {
        id = value.id,
        session = value.session,
        kind = T139.parse(value.kind),
        label = value.label,
        phase = T140.parse(value.phase),
        input_event = value.input_event,
        through = value.through,
        result_event = value.result_event,
        recovery_event = value.recovery_event
    };
}

public flow upgrade_58(value: T146) -> T145 ![] {
    return T145 {
        format = value.format,
        chain = value.chain,
        turn = value.turn,
        phase = T115.parse(value.phase),
        root = upgrade_59(value.root),
        binding = upgrade_18(value.binding)
    };
}

public flow upgrade_59(value: T144) -> T143 ![] {
    return T143 {
        version = value.version,
        authority = value.authority,
        token = value.token
    };
}

public flow upgrade_60(value: T148) -> T147 ![] {
    return T147 {
        format = value.format,
        root = upgrade_59(value.root),
        parent_proof = value.parent_proof,
        base = upgrade_49(value.base)
    };
}
