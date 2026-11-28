module nomo.domain.sessions.work;

import std.collections.Map;

import nomo.domain.conversation.{wire_traces};
import nomo.domain.conversation.{TraceKind, TraceRole};
import nomo.domain.sessions.chat.{ChatPhase};
import nomo.domain.harness.loop.ReadOperation;
import nomo.domain.wire.{value as json_value, fields as json_fields};
import nomo.domain.editing.wire_literal_edit;
import std.json.JsonValue;
import nomo.domain.conversation.TraceEvent;
import nomo.domain.editing.{
    Binding,
    Confirmed,
    LiteralEditRecord,
    Prepared,
    Selector,
    bind,
    binding_error,
    prepare_original,
    same_binding,
    selector_error
};
import nomo.domain.harness.edit.{EditLedger, history_summary_error, text_error};
import nomo.domain.harness.loop.ReadLedger;
import nomo.domain.harness.read.question_error;
import nomo.domain.harness.work.{Context, Evidence, WorkLedger, evidence_error, ledger_error, native_budget, native_tokens};
import nomo.domain.limits.{compatible_scan_i32, context_bytes, history_bytes, message_frame_bytes};
import nomo.domain.sessions.chat.{ChatSessionSnapshot, recoverable_events_invalid};
import nomo.domain.sessions.event_codec.{TraceFrame, Policy, event_text_codec_decode, redact_text};
import nomo.domain.text.{flat_string_frame, hex_digest};
import nomo.domain.wire.{encode as wire_encode, string_fields};
import std.memory.MemoryEntry;
import std.text.{char_count, concat, from_char, from_i32, from_usize, get_char_slice, join, len, parse_i32};

public enum WorkPhase {
    Running,
    Complete,
    Abandoned
}

impl WorkPhase {
    public flow wire(self) -> string ![] {
        return match self {
            WorkPhase.Running => "running",
            WorkPhase.Complete => "complete",
            WorkPhase.Abandoned => "abandoned"
        };
    }

    public flow parse(raw: string) -> WorkPhase ![] {
        return match raw {
            "running" => WorkPhase.Running,
            "complete" => WorkPhase.Complete,
            "abandoned" => WorkPhase.Abandoned,
            _ => abort("invalid WorkPhase spelling: " + raw)
        };
    }
}

public enum FollowupPhase {
    Running,
    Complete
}

impl FollowupPhase {
    public flow wire(self) -> string ![] {
        return match self {
            FollowupPhase.Running => "running",
            FollowupPhase.Complete => "complete"
        };
    }

    public flow parse(raw: string) -> FollowupPhase ![] {
        return match raw {
            "running" => FollowupPhase.Running,
            "complete" => FollowupPhase.Complete,
            _ => abort("invalid FollowupPhase spelling: " + raw)
        };
    }
}

public enum StoredWorkPhase {
    SummaryUnconfirmed,
    SummaryConfirmed
}

impl StoredWorkPhase {
    public flow wire(self) -> string ![] {
        return match self {
            StoredWorkPhase.SummaryUnconfirmed => "summary-unconfirmed",
            StoredWorkPhase.SummaryConfirmed => "summary-confirmed"
        };
    }

    public flow parse(raw: string) -> StoredWorkPhase ![] {
        return match raw {
            "summary-unconfirmed" => StoredWorkPhase.SummaryUnconfirmed,
            "summary-confirmed" => StoredWorkPhase.SummaryConfirmed,
            _ => abort("invalid StoredWorkPhase spelling: " + raw)
        };
    }
}

public enum CheckSlot {
    First,
    Followup
}

impl CheckSlot {
    public flow wire(self) -> string ![] {
        return match self {
            CheckSlot.First => "first",
            CheckSlot.Followup => "followup"
        };
    }

    public flow parse(raw: string) -> CheckSlot ![] {
        return match raw {
            "first" => CheckSlot.First,
            "followup" => CheckSlot.Followup,
            _ => abort("invalid CheckSlot spelling: " + raw)
        };
    }
}

public enum SummarySource {
    Model,
    System,
    Unknown
}

impl SummarySource {
    public flow wire(self) -> string ![] {
        return match self {
            SummarySource.Model => "model",
            SummarySource.System => "system",
            SummarySource.Unknown => "unknown"
        };
    }

    public flow parse(raw: string) -> SummarySource ![] {
        return match raw {
            "model" => SummarySource.Model,
            "system" => SummarySource.System,
            "unknown" => SummarySource.Unknown,
            _ => abort("invalid SummarySource spelling: " + raw)
        };
    }
}

public enum WorkProfile {
    Narrow,
    V2,
    Wide,
    WideV2,
    WideV3,
    WideV4,
    WideV5,
    HighInputV1,
    HighInputV2
}

impl WorkProfile {
    public flow wire(self) -> string ![] {
        return match self {
            WorkProfile.Narrow => "narrow",
            WorkProfile.V2 => "v2",
            WorkProfile.Wide => "wide",
            WorkProfile.WideV2 => "wide-v2",
            WorkProfile.WideV3 => "wide-v3",
            WorkProfile.WideV4 => "wide-v4",
            WorkProfile.WideV5 => "wide-v5",
            WorkProfile.HighInputV1 => "high-input-v1",
            WorkProfile.HighInputV2 => "high-input-v2"
        };
    }

    public flow parse(raw: string) -> WorkProfile ![] {
        return match raw {
            "narrow" => WorkProfile.Narrow,
            "v2" => WorkProfile.V2,
            "wide" => WorkProfile.Wide,
            "wide-v2" => WorkProfile.WideV2,
            "wide-v3" => WorkProfile.WideV3,
            "wide-v4" => WorkProfile.WideV4,
            "wide-v5" => WorkProfile.WideV5,
            "high-input-v1" => WorkProfile.HighInputV1,
            "high-input-v2" => WorkProfile.HighInputV2,
            _ => abort("invalid WorkProfile spelling: " + raw)
        };
    }
}

public enum SummaryProvenance {
    Unversioned(SummarySource),
    V2(SummarySource),
    V3(SummarySource),
    V4(SummarySource),
    V5(SummarySource),
    HighInput(SummarySource),
    HighInputV2(SummarySource)
}
impl SummaryProvenance {
    public flow source(self) -> SummarySource ![] {
        return match self {
            SummaryProvenance.Unversioned(value) => value,
            SummaryProvenance.V2(value) => value,
            SummaryProvenance.V3(value) => value,
            SummaryProvenance.V4(value) => value,
            SummaryProvenance.V5(value) => value,
            SummaryProvenance.HighInput(value) => value,
            SummaryProvenance.HighInputV2(value) => value
        };
    }

    public flow wire(self) -> string ![] {
        return self.source().wire() + match self {
            SummaryProvenance.Unversioned(_) => "",
            SummaryProvenance.V2(_) => "-v2",
            SummaryProvenance.V3(_) => "-v3",
            SummaryProvenance.V4(_) => "-v4",
            SummaryProvenance.V5(_) => "-v5",
            SummaryProvenance.HighInput(_) => "-high-input",
            SummaryProvenance.HighInputV2(_) => "-high-input-v2"
        };
    }

    public flow generated(profile: WorkProfile, source: SummarySource) -> SummaryProvenance ![] {
        return match profile {
            WorkProfile.Narrow => SummaryProvenance.Unversioned(source),
            WorkProfile.Wide => SummaryProvenance.Unversioned(source),
            WorkProfile.V2 => SummaryProvenance.V2(source),
            WorkProfile.WideV2 => SummaryProvenance.V2(source),
            WorkProfile.WideV3 => SummaryProvenance.V3(source),
            WorkProfile.WideV4 => SummaryProvenance.V4(source),
            WorkProfile.WideV5 => SummaryProvenance.V5(source),
            WorkProfile.HighInputV1 => SummaryProvenance.HighInput(source),
            WorkProfile.HighInputV2 => SummaryProvenance.HighInputV2(source)
        };
    }
}

public enum SummaryState {
    Running(WorkProfile),
    Complete(SummaryProvenance),
    Abandoned(WorkProfile)
}
impl SummaryState {
    public flow wire(self) -> string ![] {
        return match self {
            SummaryState.Running(_) => "running",
            SummaryState.Complete(_) => "complete",
            SummaryState.Abandoned(_) => "abandoned"
        };
    }

    public flow profile(self) -> WorkProfile ![] {
        return match self {
            SummaryState.Running(value) => value,
            SummaryState.Abandoned(value) => value,
            SummaryState.Complete(_) => abort("completed summary has no reservation")
        };
    }

    public flow source(self) -> SummarySource ![] {
        return match self {
            SummaryState.Complete(value) => value.source(),
            _ => SummarySource.Unknown
        };
    }

    public flow wire_source(self) -> string ![] {
        return match self {
            SummaryState.Running(value) => value.wire(),
            SummaryState.Abandoned(value) => value.wire(),
            SummaryState.Complete(value) => value.wire()
        };
    }

    public flow is_running(self) -> bool ![] {
        return match self {
            SummaryState.Running(_) => true,
            _ => false
        };
    }

    public flow is_complete(self) -> bool ![] {
        return match self {
            SummaryState.Complete(_) => true,
            _ => false
        };
    }

    public flow is_abandoned(self) -> bool ![] {
        return match self {
            SummaryState.Abandoned(_) => true,
            _ => false
        };
    }
}

public enum ContinuousEditState {
    NotStarted,
    Intent(Binding),
    Completed(Binding)
}
impl ContinuousEditState {
    public flow wire(self) -> string ![] {
        return match self {
            ContinuousEditState.NotStarted => "none",
            ContinuousEditState.Intent(_) => "intent",
            ContinuousEditState.Completed(_) => "completed"
        };
    }

    public flow binding(self) -> Option<Binding> ![] {
        return match self {
            ContinuousEditState.NotStarted => None(),
            ContinuousEditState.Intent(value) => Some(value),
            ContinuousEditState.Completed(value) => Some(value)
        };
    }

    public flow is_intent(self) -> bool ![] {
        return match self {
            ContinuousEditState.Intent(_) => true,
            _ => false
        };
    }

    public flow is_completed(self) -> bool ![] {
        return match self {
            ContinuousEditState.Completed(_) => true,
            _ => false
        };
    }
}

public enum CheckSummary {
    NotRequested,
    NotStartedAfterAbandoned,
    Unknown,
    Abandoned,
    Complete(CheckOutcome, Option<CheckOutput>)
}
impl CheckSummary {
    public flow wire(self) -> string ![] {
        return match self {
            CheckSummary.NotRequested => "not requested",
            CheckSummary.NotStartedAfterAbandoned => "not started after abandoned work",
            CheckSummary.Unknown => "unknown",
            CheckSummary.Abandoned => "abandoned; outcome unknown",
            CheckSummary.Complete(value, _) => value.wire()
        };
    }

    public flow wire_exit(self) -> string ![] {
        return match self {
            CheckSummary.Complete(value, _) => from_i32(value.exit_code()),
            _ => ""
        };
    }

    public flow output(self) -> Option<CheckOutput> ![] {
        return match self {
            CheckSummary.Complete(_, output) => output,
            _ => None()
        };
    }

    public flow with_output(self, output: Option<CheckOutput>) -> CheckSummary ![] {
        return match self {
            CheckSummary.Complete(value, _) => CheckSummary.Complete(value, output),
            _ => self
        };
    }

    public flow recorded(state: CheckState, output: Option<CheckOutput>) -> CheckSummary ![] {
        return match state {
            CheckState.Complete(value) => CheckSummary.Complete(value, output),
            CheckState.NotRequested => CheckSummary.NotRequested,
            CheckState.Abandoned => CheckSummary.Abandoned,
            _ => CheckSummary.Unknown
        };
    }
}

public enum CheckOutcome {
    Passed,
    Failed(i32)
}

impl CheckOutcome {
    public flow exit_code(self) -> i32 ![] {
        return match self {
            CheckOutcome.Passed => 0,
            CheckOutcome.Failed(code) => code
        };
    }

    public flow wire(self) -> string ![] {
        return match self {
            CheckOutcome.Passed => "passed",
            CheckOutcome.Failed(_) => "failed"
        };
    }

    public flow parse(outcome: string, exit: string) -> Result<CheckOutcome, string> ![] {
        if outcome == "passed" && exit == "0" {
            return Ok(CheckOutcome.Passed);
        }
        if outcome == "failed" {
            match parse_i32(exit) {
                Ok(code) => {
                    if code >= 1 && code <= 123 && from_i32(code) == exit {
                        return Ok(CheckOutcome.Failed(code));
                    }
                },
                Err(_) => (),
            }
        }
        return Err("invalid completed check outcome");
    }
}

public enum CheckState {
    NotRequested,
    Planned,
    Running,
    Complete(CheckOutcome),
    Abandoned
}

impl CheckState {
    public flow wire(self) -> string ![] {
        return match self {
            CheckState.NotRequested => "none",
            CheckState.Planned => "planned",
            CheckState.Running => "running",
            CheckState.Complete(_) => "complete",
            CheckState.Abandoned => "abandoned"
        };
    }

    public flow is_complete(self) -> bool ![] {
        return match self {
            CheckState.Complete(_) => true,
            _ => false
        };
    }

    public flow wire_outcome(self) -> string ![] {
        return match self {
            CheckState.Complete(outcome) => outcome.wire(),
            _ => ""
        };
    }

    public flow wire_exit(self) -> string ![] {
        return match self {
            CheckState.Complete(outcome) => from_i32(outcome.exit_code()),
            _ => ""
        };
    }
}

public flow invalid_values(format: i32, phase: CheckState, id: string, digest: string, allow_abandoned: bool) -> string {
    if format != 1 || phase == CheckState.NotRequested || (!allow_abandoned && phase == CheckState.Abandoned)
        || id == "" || !hex_digest(digest) {
        return "invalid history-check record";
    }
    match phase {
        CheckState.Complete(CheckOutcome.Failed(code)) => {
            if code < 1 || code > 123 {
                return "invalid completed check outcome";
            }
        },
        _ => (),
    }
    return "";
}

// Application input after CLI parsing. Help flags, option spelling and command
// trailers stay in presentation modules.
public type WorkRequest = {
    selected: Selector,
    request: string,
    allowed: Array<string>
};

public type ExecutedCheck = {
    outcome: CheckOutcome,
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

public type CheckObservation = {
    id: string,
    digest: string,
    phase: CheckState,
    output: Option<CheckOutput>
};

public type CheckOutput = {
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

public type WorkFacts = {
    id: string,
    summary: string,
    summary_source: SummarySource,
    selection: Option<string>,
    evidence: Option<string>,
    check: CheckSummary
};

public type BudgetFacts = {
    work_calls: i32,
    work_generation: i32,
    chat_used_calls: i32,
    chat_used_generation: i32,
    chat_reserved_calls: i32,
    chat_reserved_generation: i32
};

public type Facts = {
    first: Option<WorkFacts>,
    followup: Option<WorkFacts>,
    additional: Array<WorkFacts>,
    calls: i32,
    generation: i32
};

public flow historical_followup_full() -> FollowupBudget {
    return FollowupBudget {
        steps = 13,
        calls = 7,
        generation = 47104,
        native_tokens = 196608
    };
}

public flow historical_followup_zero() -> FollowupBudget {
    return FollowupBudget {
        steps = 0,
        calls = 0,
        generation = 0,
        native_tokens = 0
    };
}

public flow historical_followup_invalid(row: FollowupAttempt) -> string {
    if row.format != 1 {
        return "invalid followup phase";
    }
    let selected = selector_error(row.id, row.workspace, row.path);
    if selected != "" {
        return selected;
    }
    if row.id == row.parent.work.id {
        return "followup operation ID must differ";
    }
    if question_error(row.request) != "" || row.history_version == "" || char_count(row.history_version) > 512 {
        return "invalid followup request or history";
    }
    if row.phase == FollowupPhase.Running {
        if row.summary != "" || row.reserved != historical_followup_full() || row.settled != None() {
            return "invalid followup reservation";
        }
    } else {
        if history_summary_error(row.summary, "summary") != "" || row.reserved != historical_followup_zero() {
            return "invalid followup completion";
        }
        let spent = match row.settled {
            Some(value) => value,
            None() => {
                return "missing followup ledger";
            }
        };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls
            + spent.edit.calls != 7 || spent.read.tokens + spent.edit.tokens != 47104
            || native_tokens(spent) != 196608 {
            return "invalid followup ledger";
        }
    }
    return "";
}

public flow historical_work_full() -> WorkBudget {
    return WorkBudget {
        steps = 13,
        calls = 7,
        generation = 47104,
        native_tokens = 196608
    };
}

public flow historical_work_zero() -> WorkBudget {
    return WorkBudget {
        steps = 0,
        calls = 0,
        generation = 0,
        native_tokens = 0
    };
}

public flow generation(format: i32) -> i32 {
    return if format == 1 {
        47104
    } else {
        if format == 7 || format == 8 {
            286720
        } else {
            if format == 10 {
                917504
            } else {
                if format == 6 || format == 9 {
                    188416
                } else {
                    if format == 3 || format == 4 {
                        61440
                    } else {
                        51200
                    }
                }
            }
        }
    };
}

flow configured_native(format: i32) -> i32 {
    return if format == 10 {
        7340032
    } else {
        if format == 9 {
            6000000
        } else {
            if format == 7 || format == 8 {
                2811008
            } else {
                if format == 6 {
                    2073152
                } else {
                    if format >= 4 {
                        1335296
                    } else {
                        196608
                    }
                }
            }
        }
    };
}

// Ledger fields preserve the configured stage-shape accounting used by older
// records. Format 9 stores its 6M run ceiling in Record.reserved/format; neither
// number is actual provider usage.
flow settled_shape_native(format: i32) -> i32 {
    return if format == 9 {
        2073152
    } else {
        configured_native(format)
    };
}

flow expected_scan(format: i32, value: i32) -> bool {
    return if format == 8 || format == 9 || format == 10 {
        compatible_scan_i32(value)
    } else {
        value == 65540
    };
}

public flow historical_work_invalid(value: WorkAttempt) -> string {
    if value.format < 1 || value.format > 10 {
        return "invalid history-work phase";
    }
    let selected = selector_error(value.id, value.workspace, value.path);
    if selected != "" {
        return selected;
    }
    let question = question_error(value.request);
    if question != "" {
        return question;
    }
    if value.history_version == "" || char_count(value.history_version) > 512 {
        return "invalid history version";
    }
    if value.phase == WorkPhase.Running || value.phase == WorkPhase.Abandoned {
        let expected = if value.format == 1 {
            historical_work_full()
        } else {
            WorkBudget {
                steps = 13,
                calls = 7,
                generation = generation(value.format),
                native_tokens = configured_native(value.format)
            }
        };
        if value.summary != "" || value.reserved != expected || value.settled != None() {
            return "invalid running work reservation";
        }
    } else {
        if history_summary_error(value.summary, "summary") != "" || value.reserved != historical_work_zero() {
            return "invalid completed work summary or reservation";
        }
        let spent = match value.settled {
            Some(item) => item,
            None() => {
                return "missing settled work ledger";
            }
        };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls
            + spent.edit.calls != 7 || spent.read.tokens + spent.edit.tokens != generation(value.format)
            || (
            if value.format >= 4 {
                native_budget(spent) != settled_shape_native(value.format)
                    || !expected_scan(value.format, spent.read.scan)
            } else {
                native_tokens(spent) != 196608
            }
        ) {
            return "invalid settled work ledger";
        }
    }
    return "";
}

public flow recoverable_work_state_full(wide: bool) -> WorkBudget {
    return WorkBudget {
        steps = 13,
        calls = 7,
        generation = if wide {
            286720
        } else {
            51200
        },
        native_tokens = if wide {
            2811008
        } else {
            1335296
        }
    };
}

public flow full_mode(wide: bool, high_input: bool) -> WorkBudget {
    return if high_input {
        WorkBudget {
            steps = 13,
            calls = 7,
            generation = 917504,
            native_tokens = 7340032
        }
    } else {
        recoverable_work_state_full(wide)
    };
}

public flow recoverable_work_state_zero() -> WorkBudget {
    return WorkBudget {
        steps = 0,
        calls = 0,
        generation = 0,
        native_tokens = 0
    };
}

public flow running_record(
    id: string,
    workspace: string,
    path: string,
    request: string,
    history_version: string,
    wide: bool
) -> WorkAttempt {
    return WorkAttempt {
        format = if wide {
            8
        } else {
            5
        },
        phase = WorkPhase.Running,
        id,
        workspace,
        path,
        request,
        history_version,
        reserved = recoverable_work_state_full(wide),
        settled = None(),
        summary = ""
    };
}

public flow running_record_mode(
    id: string,
    workspace: string,
    path: string,
    request: string,
    history_version: string,
    wide: bool,
    high_input: bool
) -> WorkAttempt {
    return WorkAttempt {
        format = if high_input {
            10
        } else {
            if wide {
                8
            } else {
                5
            }
        },
        phase = WorkPhase.Running,
        id,
        workspace,
        path,
        request,
        history_version,
        reserved = full_mode(wide, high_input),
        settled = None(),
        summary = ""
    };
}

public flow completed_record(old: WorkAttempt, summary: string, spent: WorkLedger) -> WorkAttempt {
    return old {
        phase = WorkPhase.Complete,
        reserved = recoverable_work_state_zero(),
        settled = Some(spent),
        summary
    };
}

public flow abandoned_record(old: WorkAttempt, id: string, label: string) -> Result<
    WorkAttempt,
    string
> {
    if old.id != id || old.phase != WorkPhase.Running {
        return Err("interrupted " + label + " identity or phase differs");
    }
    return Ok(old {
        phase = WorkPhase.Abandoned
    });
}

public flow admission_chat_error(
    current: MemoryEntry<string, ChatSessionSnapshot>,
    expected: MemoryEntry<string, ChatSessionSnapshot>
) -> string {
    if current != expected || expected.value.chat.invocation.admitted < 1
        || expected.value.chat.phase == ChatPhase.Running || expected.value.chat.pending != "" {
        return "completed unchanged recoverable chat required";
    }
    return "";
}

public flow claim_chat_error(
    current: MemoryEntry<string, ChatSessionSnapshot>,
    expected: MemoryEntry<string, ChatSessionSnapshot>,
    work: WorkAttempt,
    label: string
) -> string {
    if current != expected || work.history_version != current.version.opaque
        || work.phase != WorkPhase.Running {
        return label + " chat binding changed; no retry";
    }
    return "";
}

public flow work_data_error(work: WorkAttempt, events: TraceFrame, policy: Policy) -> string {
    let work_error = historical_work_invalid(work);
    if work_error != "" {
        return work_error;
    }
    let event_error = recoverable_events_invalid(events, policy);
    if event_error != "" {
        return event_error;
    }
    if ((work.phase == WorkPhase.Running || work.phase == WorkPhase.Abandoned) && events.turns != 0)
        || (work.phase == WorkPhase.Complete && events.turns != 1) {
        return "work phase and event boundary differ";
    }
    @limits([Iterations(5)]) for field in [work.id, work.workspace, work.path, work.request, work.summary] {
        let checked = match redact_text(field, policy) {
            Ok(item) => item,
            Err(error) => {
                return error;
            }
        };
        if checked.replacements != 0 || checked.value != field {
            return "work data contains a known sensitive literal";
        }
    }
    @limits([Iterations(48)]) for item in events.events {
        match event_text_codec_decode(item.text, policy) {
            Ok(_) => (),
            Err(error) => {
                return error;
            }
        }
    }
    return "";
}

// Selected, validated facts from the actual work controller. This is not a
// complete raw model/effect trace, and an approval event is not a future grant.
public flow capture(pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<
    Array<TraceEvent>,
    string
> {
    let selected = pending.selected;
    let expected = match bind(selected.id, selected.workspace, selected.path, pending.prepared) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    if expected != confirmed.binding || confirmed.after != pending.prepared.proposal.after {
        return Err("confirmed edit differs from prepared work");
    }
    let problem = ledger_error(summary.state);
    if problem != "" {
        return Err(problem);
    }
    let invalid = history_summary_error(summary.answer, "summary");
    if invalid != "" {
        return Err(invalid);
    }
    let read = pending.evidence;
    // Keep fields unescaped until the event codec filters known literals.
    var selection = read.operation.wire() + "\n";
    if read.operation == ReadOperation.Search {
        selection = selection + read.literal + "\n";
    }
    if read.files.len() > 0 {
        selection = selection + join(read.files.iter().take(4).collect(), "\n") + "\n";
    }
    return Ok(
        [
            TraceEvent {
                role = TraceRole.User,
                kind = TraceKind.Request,
                name = "",
                text = pending.request
            },
            TraceEvent {
                role = TraceRole.Tool,
                kind = TraceKind.Request,
                name = read.operation.wire(),
                text = selection
            },
            TraceEvent {
                role = TraceRole.Tool,
                kind = TraceKind.Result,
                name = read.operation.wire(),
                text = read.outcome
            },
            TraceEvent {
                role = TraceRole.Assistant,
                kind = TraceKind.Result,
                name = "read-child",
                text = read.result
            },
            TraceEvent {
                role = TraceRole.Assistant,
                kind = TraceKind.Result,
                name = "read-summary",
                text = read.summary
            },
            TraceEvent {
                role = TraceRole.Assistant,
                kind = TraceKind.Delegate,
                name = "edit-child",
                text = pending.task
            },
            TraceEvent {
                role = TraceRole.User,
                kind = TraceKind.Approval,
                name = "edit",
                text = "confirmed for this invocation only"
            },
            TraceEvent {
                role = TraceRole.Tool,
                kind = TraceKind.Applied,
                name = "edit",
                text = selected.id
            },
            TraceEvent {
                role = if summary.model_generated {
                    TraceRole.Assistant
                } else {
                    TraceRole.System
                },
                kind = if summary.model_generated {
                    TraceKind.Answer
                } else {
                    TraceKind.Notice
                },
                name = "",
                text = summary.answer
            }
        ]
    );
}

// Old work records have no selection event. Never infer missing selections
// from results: a file with no matches will not appear in a search outcome.
public flow selection(events: Array<TraceEvent>, policy: Policy) -> Result<Option<string>, string> {
    @limits([Iterations(48)]) for event in events {
        if event.role == TraceRole.Tool && event.kind == TraceKind.Request && (
            event.name == "read"
                || event.name == "search"
        ) {
            let text = match event_text_codec_decode(event.text, policy) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            };
            return Ok(Some(text));
        }
    }
    return Ok(None());
}

// The canonical work record retains the complete selected read/search result.
// Timeline copies may be compacted, so resumed model context must project this
// field from the canonical record rather than from the display timeline.
public flow evidence(events: Array<TraceEvent>, policy: Policy) -> Result<Option<string>, string> {
    var selected: Option<string> = None();
    @limits([Iterations(48)]) for event in events {
        if event.role == TraceRole.Tool && event.kind == TraceKind.Result && (
            event.name == "read"
                || event.name == "search"
        ) {
            if selected != None() {
                return Err("multiple canonical work evidence events");
            }
            let text = match event_text_codec_decode(event.text, policy) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            };
            selected = Some(text);
        }
    }
    return Ok(selected);
}

// Older or incomplete records may lack attributable events; never guess their origin.
public flow summary_source(frame: TraceFrame, summary: string, policy: Policy) -> Result<
    SummarySource,
    string
> {
    var origin = SummarySource.Unknown;
    var matches: usize = 0;
    @limits([Iterations(48)]) for event in frame.events {
        if (event.role == TraceRole.Assistant && event.kind == TraceKind.Answer)
            || (
            event.role == TraceRole.System
                && event.kind == TraceKind.Notice
        ) {
            let value = match event_text_codec_decode(event.text, policy) {
                Ok(item) => item,
                Err(error) => {
                    return Err(error);
                }
            };
            if value == summary {
                matches = matches + 1;
                origin = if event.role == TraceRole.System {
                    SummarySource.System
                } else {
                    SummarySource.Model
                };
            }
        }
    }
    return Ok(if matches == 1 {
        origin
    } else {
        SummarySource.Unknown
    });
}

public type WorkUsage = {
    calls: i32,
    generation: i32
};

public flow settled_usage(value: WorkLedger) -> WorkUsage {
    return WorkUsage {
        calls = value.read.calls + value.edit.calls,
        generation = value.read.tokens + value.edit.tokens
    };
}

public flow stored_fact(id: string, summary: string, source: SummarySource, check: CheckSummary) -> WorkFacts {
    return WorkFacts {
        id,
        summary,
        summary_source = source,
        selection = None(),
        evidence = None(),
        check
    };
}

public flow abandoned_fact(id: string) -> WorkFacts {
    return stored_fact(
        id,
        "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.",
        SummarySource.System,
        CheckSummary.Unknown
    );
}

// Pure projections of captured historical records; no storage, file or model calls.
public flow extra_fact(item: ContinuousWorkEntry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase.is_abandoned() && (
        item.check.phase == CheckState.NotRequested
            || item.check.phase == CheckState.Planned
    ) {
        return Ok(abandoned_fact(item.core.id));
    }
    if !item.result.phase.is_complete() || (
        item.check.phase != CheckState.NotRequested && !item.check.phase.is_complete()
            && item.check.phase != CheckState.Abandoned
    ) {
        return Err("continuous work unresolved");
    }
    var output: Option<CheckOutput> = None();
    if item.check.phase.is_complete() {
        output = Some(
            match check_values(
                item.check.stdout,
                item.check.stderr,
                item.check.stdout_truncated,
                item.check.stderr_truncated,
                policy
            ) {
                Ok(value) => value,
                Err(error) => {
                    return Err(error);
                }
            }
        );
    }
    let chosen = match selection(item.result.events, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let observed = match evidence(item.result.events, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(
        WorkFacts {
            id = item.core.id,
            summary = item.result.summary,
            summary_source = item.result.phase.source(),
            selection = chosen,
            evidence = observed,
            check = CheckSummary.recorded(item.check.phase, output)
        }
    );
}

// Keep older diagnostics at the original per-stream context bound; the stored
// excerpts remain intact and the two latest checks retain their wider context.
flow short_text(value: string) -> string {
    if char_count(value) <= 128 {
        return value;
    }
    return match get_char_slice(value, Range.closed(0, 127)) {
        Some(text) => text,
        None() => ""
    };
}

public flow compact(value: WorkFacts) -> WorkFacts {
    let output = match value.check.output() {
        None() => None(),
        Some(item) => {
            let out = short_text(item.stdout);
            let err = short_text(item.stderr);
            Some(
                CheckOutput {
                    stdout = out,
                    stderr = err,
                    stdout_truncated = item.stdout_truncated
                        || out != item.stdout,
                    stderr_truncated = item.stderr_truncated || err != item.stderr
                }
            )
        }
    };
    return value {
        evidence = None(),
        check = value.check.with_output(output)
    };
}

// Only completed recorded actions become untrusted model context. An uncertain
// edit or check is not retried and cannot be represented as a successful fact.
public flow check_values(
    stdout: string,
    stderr: string,
    out_truncated: bool,
    err_truncated: bool,
    policy: Policy
) -> Result<CheckOutput, string> {
    let out = match event_text_codec_decode(stdout, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    let err = match event_text_codec_decode(stderr, policy) {
        Ok(item) => item,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(
        CheckOutput {
            stdout = out,
            stderr = err,
            stdout_truncated = out_truncated,
            stderr_truncated = err_truncated
        }
    );
}

public flow completed_fact(
    work: WorkAttempt,
    events: TraceFrame,
    check: Option<CheckObservation>,
    policy: Policy,
    label: string
) -> Result<WorkFacts, string> {
    let outcome = match check {
        None() => CheckSummary.NotRequested,
        Some(value) => match value.phase {
            CheckState.Complete(result) => CheckSummary.Complete(result, value.output),
            CheckState.Abandoned => CheckSummary.Abandoned,
            _ => {
                return Err(label + " check unresolved");
            }
        }
    };
    let origin = match summary_source(events, work.summary, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let chosen = match selection(events.events, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let observed = match evidence(events.events, policy) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    return Ok(
        WorkFacts {
            id = work.id,
            summary = work.summary,
            summary_source = origin,
            selection = chosen,
            evidence = observed,
            check = outcome
        }
    );
}

public type Captured = {
    binding: Binding,
    evidence: Evidence,
    task: string,
    target: string,
    replacement: string,
    before: string,
    after: string,
    summary: string,
    ledger: WorkLedger
};

flow stage(confirmed: bool, read: ReadLedger) -> WorkLedger {
    return WorkLedger {
        read,
        edit = EditLedger {
            steps = if confirmed {
                6
            } else {
                5
            },
            calls = if confirmed {
                3
            } else {
                2
            },
            tokens = if confirmed {
                38912
            } else {
                36864
            },
            native_tokens = if confirmed {
                163840
            } else {
                98304
            },
            boundaries = 3
        }
    };
}

// This frame admits quoted Unicode. The native parser subsequently checks
// separators and escapes; no nested or non-string leaf reaches decoding.
flow framed(raw: string) -> bool {
    return flat_string_frame(raw, 52, true);
}

flow fields_error(fields: Array<string>) -> string {
    if fields.len() != 52 {
        return "work record requires exactly 52 string fields";
    }
    var total: usize = 0;
    @limits([Iterations(52)]) for field in fields {
        if char_count(field) > message_frame_bytes() {
            return "work record field exceeds 8388608 decoded UTF-8 bytes";
        }
        let size = len(field);
        total = total + size;
        if size > message_frame_bytes() || total > context_bytes() {
            return "work record exceeds decoded UTF-8 byte bounds";
        }
    }
    return "";
}

flow decode(body: string) -> Result<Array<string>, string> {
    if !framed(body) {
        return Err("work record encoded framing or 33554432-byte bound invalid");
    }
    let fields = match string_fields(body, "invalid work record JSON", "work record fields must be strings") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    let invalid = fields_error(fields);
    if invalid != "" {
        return Err(invalid);
    }
    return Ok(fields);
}

flow outer_error(row: CapturedWork) -> string {
    let encoded = match wire_encode(
        wire_stored_work(row),
        "work row conversion refused",
        "work row serialization refused"
    ) {
        Ok(value) => value,
        Err(error) => {
            return error;
        }
    };
    if len(encoded) > history_bytes() {
        return "work row exceeds 67108864 serialized UTF-8 bytes";
    }
    return "";
}

flow fields(value: Captured, phase: StoredWorkPhase) -> Array<string> {
    let binding = value.binding;
    let read = value.ledger.read;
    let edit = value.ledger.edit;
    var allowed_second = "";
    if value.evidence.allowed.len() == 2 {
        allowed_second = value.evidence.allowed[1];
    }
    var selected_second = "";
    if value.evidence.files.len() == 2 {
        selected_second = value.evidence.files[1];
    }
    let confirmed = phase == StoredWorkPhase.SummaryConfirmed;
    return [
        "nomo-work-record-v1",
        phase.wire(),
        binding.id,
        binding.workspace,
        binding.region,
        binding.path,
        binding.request_digest,
        binding.before_digest,
        binding.after_digest,
        from_usize(binding.before_bytes),
        from_usize(binding.after_bytes),
        value.evidence.request,
        value.evidence.task,
        value.evidence.operation.wire(),
        value.evidence.allowed[0],
        allowed_second,
        value.evidence.files[0],
        selected_second,
        value.evidence.literal,
        value.evidence.outcome,
        value.evidence.result,
        value.evidence.summary,
        value.task,
        value.target,
        value.replacement,
        value.before,
        value.after,
        value.summary,
        from_i32(read.steps),
        from_i32(read.calls),
        from_i32(read.tokens),
        from_i32(read.tools),
        from_i32(read.scan),
        from_i32(edit.steps),
        from_i32(edit.calls),
        from_i32(edit.tokens),
        from_i32(edit.native_tokens),
        from_i32(edit.boundaries),
        "13",
        "7",
        "47104",
        "196608",
        "1",
        "4096",
        "3",
        "6144",
        "1",
        "2048",
        if confirmed {
            "0"
        } else {
            "1"
        },
        if confirmed {
            "0"
        } else {
            "1"
        },
        if confirmed {
            "0"
        } else {
            "2048"
        },
        if confirmed {
            "0"
        } else {
            "65536"
        }
    ];
}

flow encode(value: Captured, phase: StoredWorkPhase) -> Result<CapturedWork, string> {
    if value.evidence.allowed.len() > 2 || value.evidence.files.len() > 2 {
        return Err("legacy work record supports at most two files");
    }
    let projection = fields(value, phase);
    let invalid = fields_error(projection);
    if invalid != "" {
        return Err(invalid);
    }
    let body = match wire_encode(projection, "work body conversion refused", "work body encoding refused") {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !framed(body) {
        return Err("work record encoded bounds exceeded");
    }
    let row = CapturedWork {
        format = 1,
        phase,
        binding = value.binding,
        body
    };
    let outer = outer_error(row);
    if outer != "" {
        return Err(outer);
    }
    return Ok(row);
}

public flow validate(row: CapturedWork) -> Result<Captured, string> {
    if row.format != 1 {
        return Err("unsupported work record format or phase");
    }
    let invalid = binding_error(row.binding);
    if invalid != "" {
        return Err(invalid);
    }
    let data = match decode(row.body) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if data[0] != "nomo-work-record-v1" || data[1] != row.phase.wire() {
        return Err("work body marker or phase mismatch");
    }
    let prepared = match prepare_original(data[5], data[25], data[23], data[24]) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if prepared.proposal.before == "" || prepared.proposal.after != data[26] {
        return Err("work literal edit result mismatch");
    }
    let binding = match bind(data[2], data[3], data[5], prepared) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !same_binding(binding, row.binding) || data[4] != binding.region || data[6] != binding.request_digest
        || data[7] != binding.before_digest || data[8] != binding.after_digest
        || data[9] != from_usize(binding.before_bytes) || data[10] != from_usize(binding.after_bytes) {
        return Err("work body or outer edit binding mismatch");
    }
    var allowed = [data[14]];
    if data[15] != "" {
        allowed = allowed.push(data[15]);
    }
    var selected = [data[16]];
    if data[17] != "" {
        selected = selected.push(data[17]);
    }
    let read = ReadLedger {
        steps = 7,
        calls = 4,
        tokens = 8192,
        tools = 1,
        scan = 4096
    };
    let evidence = Evidence {
        request = data[11],
        task = data[12],
        operation = ReadOperation.parse(data[13]),
        files = selected,
        literal = data[18],
        outcome = data[19],
        result = data[20],
        summary = data[21],
        allowed,
        ledger = read
    };
    let invalid_evidence = evidence_error(evidence);
    if invalid_evidence != "" {
        return Err(invalid_evidence);
    }
    let invalid_task = text_error(data[22], "saved edit task");
    if invalid_task != "" {
        return Err(invalid_task);
    }
    let confirmed = row.phase == StoredWorkPhase.SummaryConfirmed;
    if confirmed {
        let summary = text_error(data[27], "saved final summary");
        if summary != "" {
            return Err(summary);
        }
    } else if data[27] != "" {
        return Err("unconfirmed work record carries a final summary");
    }
    let captured = Captured {
        binding,
        evidence,
        task = data[22],
        target = data[23],
        replacement = data[24],
        before = data[25],
        after = data[26],
        summary = data[27],
        ledger = stage(confirmed, read)
    };
    // Exact canonical strings reject leading zeros, signs and every other
    // stage/maxima/reservation value without parsing untrusted integers.
    if fields(captured, row.phase) != data {
        return Err("work record canonical counters or projection mismatch");
    }
    let outer = outer_error(row);
    if outer != "" {
        return Err(outer);
    }
    return Ok(captured);
}

// A predicted valid binding is admission data, never completion authority.
// Only the caller's matched typed Confirmed result permits publication.
public flow partial(binding: Binding, evidence: Evidence, task: string, prepared: Prepared) -> Result<
    CapturedWork,
    string
> {
    let invalid = binding_error(binding);
    if invalid != "" {
        return Err(invalid);
    }
    let proof = evidence_error(evidence);
    if proof != "" {
        return Err(proof);
    }
    let invalid_task = text_error(task, "saved edit task");
    if invalid_task != "" {
        return Err(invalid_task);
    }
    let selected = match bind(binding.id, binding.workspace, binding.path, prepared) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if !same_binding(selected, binding) {
        return Err("work admission binding mismatch");
    }
    let captured = Captured {
        binding,
        evidence,
        task,
        target = prepared.request.target,
        replacement = prepared.request.replacement,
        before = prepared.proposal.before,
        after = prepared.proposal.after,
        summary = "",
        ledger = stage(false, evidence.ledger)
    };
    let row = match encode(captured, StoredWorkPhase.SummaryUnconfirmed) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match validate(row) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    return Ok(row);
}

public flow confirm(row: CapturedWork, summary: string) -> Result<CapturedWork, string> {
    let captured = match validate(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if row.phase != StoredWorkPhase.SummaryUnconfirmed {
        return Err("work summary update requires an unconfirmed record");
    }
    let invalid = text_error(summary, "saved final summary");
    if invalid != "" {
        return Err(invalid);
    }
    let complete = captured {
        summary,
        ledger = stage(true, captured.evidence.ledger)
    };
    let result = match encode(complete, StoredWorkPhase.SummaryConfirmed) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    match validate(result) {
        Ok(_) => (),
        Err(error) => {
            return Err(error);
        }
    }
    return Ok(result);
}

// This hypothetical summary supplies the maximum escape expansion, including
// second escaping in the complete row. Capacity admission grants no completion
// authority and does not require the hypothetical text to be a valid summary.
public flow admit(row: CapturedWork) -> Result<bool, string> {
    let captured = match validate(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if row.phase != StoredWorkPhase.SummaryUnconfirmed {
        return Err("work admission requires an unconfirmed candidate");
    }
    let control = from_char(char.from_u32(1).unwrap());
    let repeated: Array<string> = Array.repeat(512, control);
    let summary = concat(repeated);
    let hypothetical = captured {
        summary,
        ledger = stage(true, captured.evidence.ledger)
    };
    return match encode(hypothetical, StoredWorkPhase.SummaryConfirmed) {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow same_record(left: CapturedWork, right: CapturedWork) -> bool {
    return left == right;
}

public type Failure = {
    state: WorkLedger,
    error: string
};

public type Pending = {
    selected: Selector,
    prepared: Prepared,
    evidence: Evidence,
    request: string,
    task: string,
    state: WorkLedger,
    high_input: bool
};

public type Completed = {
    context: Context,
    state: WorkLedger,
    high_input: bool
};

public type Summary = {
    answer: string,
    state: WorkLedger,
    model_generated: bool
};

// Output is untrusted diagnostic text, never authority or evidence that a
// command may run again. Records bind to an independently completed check.
public type CapturedCheckOutput = {
    format: i32,
    slot: CheckSlot,
    id: string,
    digest: string,
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

public type CapturedCheckAttempt = {
    format: i32,
    policy_binding: string,
    work_history: string,
    workspace: string,
    path: string,
    check: CheckAttempt,
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

// All additional rounds share one append-only history and one current slot.
// Each current edit/check transition is durable before its external effect.
public type ContinuousCore = {
    id: string,
    request: string
};

public type WorkSummary = {
    phase: SummaryState,
    summary: string,
    calls: i32,
    generation: i32,
    events: Array<TraceEvent>
};

public type ContinuousCheckAttempt = {
    phase: CheckState,
    digest: string,
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

public type ContinuousWorkEntry = {
    core: ContinuousCore,
    edit: ContinuousEditState,
    result: WorkSummary,
    check: ContinuousCheckAttempt
};

public type ContinuousWorkHistory = {
    binding: string,
    history: Array<ContinuousWorkEntry>,
    current: ContinuousWorkEntry
};

public type CheckAttempt = {
    format: i32,
    phase: CheckState,
    id: string,
    digest: string
};

// One additional work attempt, with separate reserved budget and fresh grants.
// The predecessor is untrusted recorded context, not a current root witness.
public type FollowupBudget = {
    steps: i32,
    calls: i32,
    generation: i32,
    native_tokens: i32
};

public type FollowupPredecessor = {
    work: WorkAttempt,
    edit: LiteralEditRecord,
    check: Option<CheckAttempt>
};

public type FollowupAttempt = {
    format: i32,
    phase: FollowupPhase,
    id: string,
    workspace: string,
    path: string,
    request: string,
    history_version: string,
    parent: FollowupPredecessor,
    reserved: FollowupBudget,
    settled: Option<WorkLedger>,
    summary: string
};

// This record prevents a second dispatched work request for this session.
// It is not a File receipt, root identity, user approval, or Host witness.
public type WorkBudget = {
    steps: i32,
    calls: i32,
    generation: i32,
    native_tokens: i32
};

public type WorkAttempt = {
    format: i32,
    phase: WorkPhase,
    id: string,
    workspace: string,
    path: string,
    request: string,
    history_version: string,
    reserved: WorkBudget,
    settled: Option<WorkLedger>,
    summary: string
};

// One separately reserved followup slot linked to the current event-chat version.
// The work row and its bounded event batch commit together. Edit intent remains
// a separate durable boundary; if any boundary is uncertain, callers must
// retain the reservation and refuse replay rather than infer an outcome.
public type FollowupSessionFrame = {
    format: i32,
    policy_binding: string,
    parent_work_version: string,
    parent_check_version: string,
    work: WorkAttempt,
    events: TraceFrame
};

// One separately reserved work slot linked to the current event-chat version.
// The work row and its bounded event batch commit together. Edit intent remains
// a separate durable boundary; if any boundary is uncertain, callers must
// retain the reservation and refuse replay rather than infer an outcome.
public type WorkSessionFrame = {
    format: i32,
    policy_binding: string,
    work: WorkAttempt,
    events: TraceFrame
};

public type CapturedWork = {
    format: i32,
    phase: StoredWorkPhase,
    binding: Binding,
    body: string
};

public flow wire_check_attempt(input: CheckAttempt) -> JsonValue ![] {
    return json_fields(
        json_value(input),
        [
            ("phase", JsonValue.String(input.phase.wire())),
            ("outcome", JsonValue.String(input.phase.wire_outcome())),
            ("exit_code", JsonValue.String(input.phase.wire_exit()))
        ]
    );
}

public flow wire_check_frame(input: CapturedCheckAttempt) -> JsonValue ![] {
    return json_fields(json_value(input), [("check", wire_check_attempt(input.check))]);
}

public flow wire_check_output(input: CapturedCheckOutput) -> JsonValue ![] {
    return json_fields(json_value(input), [("slot", JsonValue.String(input.slot.wire()))]);
}

public flow wire_work(input: WorkAttempt) -> JsonValue ![] {
    return json_fields(json_value(input), [("phase", JsonValue.String(input.phase.wire()))]);
}

public flow wire_stored_work(input: CapturedWork) -> JsonValue ![] {
    return json_fields(json_value(input), [("phase", JsonValue.String(input.phase.wire()))]);
}

public flow wire_followup(input: FollowupAttempt) -> JsonValue ![] {
    let parent = json_fields(
        json_value(input.parent),
        [
            ("work", wire_work(input.parent.work)),
            ("edit", wire_literal_edit(input.parent.edit)),
            ("check", json_value(input.parent.check.map(item => wire_check_attempt(item))))
        ]
    );
    return json_fields(
        json_value(input),
        [("phase", JsonValue.String(input.phase.wire())), ("parent", parent)]
    );
}

public flow wire_work_fact(input: WorkFacts) -> JsonValue ![] {
    return json_fields(
        json_value(input),
        [
            ("summary_source", JsonValue.String(input.summary_source.wire())),
            ("check", JsonValue.String(input.check.wire())),
            ("exit_code", JsonValue.String(input.check.wire_exit())),
            ("output", json_value(input.check.output()))
        ]
    );
}

public flow wire_continuous(input: ContinuousWorkEntry) -> JsonValue ![] {
    let edit = json_fields(
        JsonValue.Object(Map.new()),
        [("phase", JsonValue.String(input.edit.wire())), ("binding", json_value(input.edit.binding()))]
    );
    let result = json_fields(
        json_value(input.result),
        [
            ("events", wire_traces(input.result.events)),
            ("phase", JsonValue.String(input.result.phase.wire())),
            ("source", JsonValue.String(input.result.phase.wire_source()))
        ]
    );
    let check = json_fields(
        json_value(input.check),
        [
            ("phase", JsonValue.String(input.check.phase.wire())),
            ("outcome", JsonValue.String(input.check.phase.wire_outcome())),
            ("exit_code", JsonValue.String(input.check.phase.wire_exit()))
        ]
    );
    return json_fields(json_value(input), [("edit", edit), ("result", result), ("check", check)]);
}
