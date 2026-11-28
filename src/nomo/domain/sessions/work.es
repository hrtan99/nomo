module nomo.domain.sessions.work;

import nomo.core.conversation.Event;
import nomo.domain.editing.{
    Confirmed,
    Prepared,
    Selector,
    bind,
    binding_error,
    prepare_original,
    same_binding,
    selector_error
};
import nomo.domain.harness.edit.{history_summary_error, text_error};
import nomo.domain.harness.read.question_error;
import nomo.domain.harness.work.{Context, Evidence, evidence_error, ledger_error, native_budget, native_tokens};
import nomo.domain.limits.{compatible_scan_i32, context_bytes, history_bytes, message_frame_bytes};
import nomo.domain.sessions.chat.recoverable_events_invalid;
import nomo.domain.sessions.event_codec.{Policy, event_text_codec_decode, redact_text};
import nomo.domain.text.{flat_string_frame, hex_digest};
import nomo.domain.wire.{encode as wire_encode, string_fields};
import nomo.harness.harness_edit_contract.Ledger as harness_edit_contract_Ledger;
import nomo.harness.harness_tool_contract.Ledger as harness_tool_contract_Ledger;
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.continuous_work.Entry;
import nomo.session.edit_operation.Binding;
import nomo.session.history_followup_guard.{Budget, Record};
import nomo.session.history_work_guard.{Budget as history_work_guard_Budget, Record as history_work_guard_Record};
import nomo.session.recoverable_chat_store.Frame;
import nomo.session.recoverable_events.Frame as recoverable_events_Frame;
import nomo.session.work_record.Record as work_record_Record;
import std.agent.message.Message;
import std.bytes.len as bytes_len;
import std.codec.text.utf8_encode;
import std.json.parse;
import std.memory.MemoryEntry;
import std.text.{char_count, from_char, from_i32, from_usize, get_char_slice, len, parse_i32};

flow valid_failure_code(value: string) -> bool {
    if char_count(value) < 1 || char_count(value) > 3 {
        return false;
    }
    return match parse_i32(value) {
        Ok(number) => number >= 1 && number <= 123 && from_i32(number) == value,
        Err(_) => false
    };
}

public flow invalid_values(
    format: i32,
    phase: string,
    id: string,
    digest: string,
    outcome: string,
    exit_code: string,
    allow_abandoned: bool
) -> string {
    if format != 1 || (phase != "planned" && phase != "running" && phase != "complete" && !(
        allow_abandoned
            && phase == "abandoned"
    )) || id == "" || !hex_digest(digest) {
        return "invalid history-check record";
    }
    if phase != "complete" {
        if outcome != "" || exit_code != "" {
            return "unfinished check has an outcome";
        }
    } else if !((outcome == "passed" && exit_code == "0") || (
        outcome == "failed"
            && valid_failure_code(exit_code)
    )) {
        return "invalid completed check outcome";
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

public type CheckResult = {
    outcome: string,
    exit_code: string,
    stdout: string,
    stderr: string,
    stdout_truncated: bool,
    stderr_truncated: bool
};

public type CheckFacts = {
    id: string,
    digest: string,
    phase: string,
    outcome: string,
    exit_code: string,
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
    summary_source: string,
    selection: Option<string>,
    evidence: Option<string>,
    check: string,
    exit_code: string,
    output: Option<CheckOutput>
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

public flow historical_followup_full() -> Budget {
    return Budget {
        steps = 13,
        calls = 7,
        generation = 47104,
        native_tokens = 196608
    };
}

public flow historical_followup_zero() -> Budget {
    return Budget {
        steps = 0,
        calls = 0,
        generation = 0,
        native_tokens = 0
    };
}

public flow historical_followup_invalid(row: Record) -> string {
    if row.format != 1 || (row.phase != "running" && row.phase != "complete") {
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
    if row.phase == "running" {
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

public flow historical_work_full() -> history_work_guard_Budget {
    return history_work_guard_Budget {
        steps = 13,
        calls = 7,
        generation = 47104,
        native_tokens = 196608
    };
}

public flow historical_work_zero() -> history_work_guard_Budget {
    return history_work_guard_Budget {
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

public flow historical_work_invalid(value: history_work_guard_Record) -> string {
    if (value.format < 1 || value.format > 10) || (
        value.phase != "running" && value.phase != "complete"
            && value.phase != "abandoned"
    ) {
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
    if value.phase == "running" || value.phase == "abandoned" {
        let expected = if value.format == 1 {
            historical_work_full()
        } else {
            history_work_guard_Budget {
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

public flow recoverable_work_state_full(wide: bool) -> history_work_guard_Budget {
    return history_work_guard_Budget {
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

public flow full_mode(wide: bool, high_input: bool) -> history_work_guard_Budget {
    return if high_input {
        history_work_guard_Budget {
            steps = 13,
            calls = 7,
            generation = 917504,
            native_tokens = 7340032
        }
    } else {
        recoverable_work_state_full(wide)
    };
}

public flow recoverable_work_state_zero() -> history_work_guard_Budget {
    return history_work_guard_Budget {
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
) -> history_work_guard_Record {
    return history_work_guard_Record {
        format = if wide {
            8
        } else {
            5
        },
        phase = "running",
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
) -> history_work_guard_Record {
    return history_work_guard_Record {
        format = if high_input {
            10
        } else {
            if wide {
                8
            } else {
                5
            }
        },
        phase = "running",
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

public flow completed_record(old: history_work_guard_Record, summary: string, spent: Ledger) -> history_work_guard_Record {
    return old {
        phase = "complete",
        reserved = recoverable_work_state_zero(),
        settled = Some(spent),
        summary
    };
}

public flow abandoned_record(old: history_work_guard_Record, id: string, label: string) -> Result<
    history_work_guard_Record,
    string
> {
    if old.id != id || old.phase != "running" {
        return Err("interrupted " + label + " identity or phase differs");
    }
    return Ok(old {
        phase = "abandoned"
    });
}

public flow admission_chat_error(current: MemoryEntry<string, Frame>, expected: MemoryEntry<string, Frame>) -> string {
    if current != expected || expected.value.chat.invocation.admitted < 1
        || expected.value.chat.phase == "running" || expected.value.chat.pending != "" {
        return "completed unchanged recoverable chat required";
    }
    return "";
}

public flow claim_chat_error(
    current: MemoryEntry<string, Frame>,
    expected: MemoryEntry<string, Frame>,
    work: history_work_guard_Record,
    label: string
) -> string {
    if current != expected || work.history_version != current.version.opaque || work.phase != "running" {
        return label + " chat binding changed; no retry";
    }
    return "";
}

public flow work_data_error(work: history_work_guard_Record, events: recoverable_events_Frame, policy: Policy) -> string {
    let work_error = historical_work_invalid(work);
    if work_error != "" {
        return work_error;
    }
    let event_error = recoverable_events_invalid(events, policy);
    if event_error != "" {
        return event_error;
    }
    if ((work.phase == "running" || work.phase == "abandoned") && events.turns != 0)
        || (work.phase == "complete" && events.turns != 1) {
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
public flow capture(pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> {
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
    var selection = read.operation + "\n";
    if read.operation == "search" {
        selection = selection + read.literal + "\n";
    }
    @limits([Iterations(4)]) for name in read.files {
        selection = selection + name + "\n";
    }
    return Ok(
        [
            Event {
                role = "user",
                kind = "request",
                name = "",
                text = pending.request
            },
            Event {
                role = "tool",
                kind = "request",
                name = read.operation,
                text = selection
            },
            Event {
                role = "tool",
                kind = "result",
                name = read.operation,
                text = read.outcome
            },
            Event {
                role = "assistant",
                kind = "result",
                name = "read-child",
                text = read.result
            },
            Event {
                role = "assistant",
                kind = "result",
                name = "read-summary",
                text = read.summary
            },
            Event {
                role = "assistant",
                kind = "delegate",
                name = "edit-child",
                text = pending.task
            },
            Event {
                role = "user",
                kind = "approval",
                name = "edit",
                text = "confirmed for this invocation only"
            },
            Event {
                role = "tool",
                kind = "applied",
                name = "edit",
                text = selected.id
            },
            Event {
                role = if summary.model_generated {
                    "assistant"
                } else {
                    "system"
                },
                kind = if summary.model_generated {
                    "answer"
                } else {
                    "notice"
                },
                name = "",
                text = summary.answer
            }
        ]
    );
}

// Old work records have no selection event. Never infer missing selections
// from results: a file with no matches will not appear in a search outcome.
public flow selection(events: Array<Event>, policy: Policy) -> Result<Option<string>, string> {
    @limits([Iterations(48)]) for event in events {
        if event.role == "tool" && event.kind == "request" && (event.name == "read" || event.name == "search") {
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
public flow evidence(events: Array<Event>, policy: Policy) -> Result<Option<string>, string> {
    var selected: Option<string> = None();
    @limits([Iterations(48)]) for event in events {
        if event.role == "tool" && event.kind == "result" && (event.name == "read" || event.name == "search") {
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
public flow summary_source(frame: recoverable_events_Frame, summary: string, policy: Policy) -> Result<
    string,
    string
> {
    var origin = "unknown";
    var matches: usize = 0;
    @limits([Iterations(48)]) for event in frame.events {
        if (event.role == "assistant" && event.kind == "answer") || (
            event.role == "system"
                && event.kind == "notice"
        ) {
            let value = match event_text_codec_decode(event.text, policy) {
                Ok(item) => item,
                Err(error) => {
                    return Err(error);
                }
            };
            if value == summary {
                matches = matches + 1;
                origin = if event.role == "system" {
                    "system"
                } else {
                    "model"
                };
            }
        }
    }
    return Ok(if matches == 1 {
        origin
    } else {
        "unknown"
    });
}

public type WorkUsage = {
    calls: i32,
    generation: i32
};

public flow settled_usage(value: Ledger) -> WorkUsage {
    return WorkUsage {
        calls = value.read.calls + value.edit.calls,
        generation = value.read.tokens + value.edit.tokens
    };
}

public flow stored_fact(
    id: string,
    summary: string,
    source: string,
    check: string,
    exit_code: string,
    output: Option<CheckOutput>
) -> WorkFacts {
    return WorkFacts {
        id,
        summary,
        summary_source = source,
        selection = None(),
        evidence = None(),
        check,
        exit_code,
        output
    };
}

public flow abandoned_fact(id: string) -> WorkFacts {
    return stored_fact(
        id,
        "User abandoned interrupted work; its effect is unknown. Inspect the file before a new edit.",
        "system",
        "unknown",
        "",
        None()
    );
}

// Pure projections of captured historical records; no storage, file or model calls.
public flow extra_fact(item: Entry, policy: Policy) -> Result<WorkFacts, string> {
    if item.result.phase == "abandoned" && (item.check.phase == "none" || item.check.phase == "planned") {
        return Ok(abandoned_fact(item.core.id));
    }
    if item.result.phase != "complete" || (
        item.check.phase != "none" && item.check.phase != "complete"
            && item.check.phase != "abandoned"
    ) {
        return Err("continuous work unresolved");
    }
    var output: Option<CheckOutput> = None();
    if item.check.phase == "complete" {
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
            summary_source = if (
                item.result.source == "model-v2" || item.result.source == "model-v3"
                    || item.result.source == "model-v4" || item.result.source == "model-v5"
                    || item.result.source == "model-high-input"
                    || item.result.source == "model-high-input-v2"
            ) {
                "model"
            } else {
                if (
                    item.result.source == "system-v2" || item.result.source == "system-v3"
                        || item.result.source == "system-v4" || item.result.source == "system-v5"
                        || item.result.source == "system-high-input"
                        || item.result.source == "system-high-input-v2"
                ) {
                    "system"
                } else {
                    item.result.source
                }
            },
            selection = chosen,
            evidence = observed,
            check = if item.check.phase == "none" {
                "not requested"
            } else {
                if item.check.phase == "abandoned" {
                    "abandoned; outcome unknown"
                } else {
                    item.check.outcome
                }
            },
            exit_code = item.check.exit_code,
            output
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
    let output = match value.output {
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
        output
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
    work: history_work_guard_Record,
    events: recoverable_events_Frame,
    check: Option<CheckFacts>,
    policy: Policy,
    label: string
) -> Result<WorkFacts, string> {
    var outcome = "not requested";
    var exit = "";
    var output: Option<CheckOutput> = None();
    match check {
        Some(value) => if value.phase == "abandoned" {
            outcome = "abandoned; outcome unknown";
        } else {
            if value.phase != "complete" {
                return Err(label + " check unresolved");
            }
            outcome = value.outcome;
            exit = value.exit_code;
            output = value.output;
        },
        None() => (),
    }
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
            check = outcome,
            exit_code = exit,
            output
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
    ledger: Ledger
};

flow stage(confirmed: bool, read: harness_tool_contract_Ledger) -> Ledger {
    return Ledger {
        read,
        edit = harness_edit_contract_Ledger {
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

flow outer_error(row: work_record_Record) -> string {
    let encoded = match wire_encode(row, "work row conversion refused", "work row serialization refused") {
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

flow fields(value: Captured, phase: string) -> Array<string> {
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
    let confirmed = phase == "summary-confirmed";
    return [
        "nomo-work-record-v1",
        phase,
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
        value.evidence.operation,
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

flow encode(value: Captured, phase: string) -> Result<work_record_Record, string> {
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
    let row = work_record_Record {
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

public flow validate(row: work_record_Record) -> Result<Captured, string> {
    if row.format != 1 || (row.phase != "summary-unconfirmed" && row.phase != "summary-confirmed") {
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
    if data[0] != "nomo-work-record-v1" || data[1] != row.phase {
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
    let read = harness_tool_contract_Ledger {
        steps = 7,
        calls = 4,
        tokens = 8192,
        tools = 1,
        scan = 4096
    };
    let evidence = Evidence {
        request = data[11],
        task = data[12],
        operation = data[13],
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
    let confirmed = row.phase == "summary-confirmed";
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
    work_record_Record,
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
    let row = match encode(captured, "summary-unconfirmed") {
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

public flow confirm(row: work_record_Record, summary: string) -> Result<work_record_Record, string> {
    let captured = match validate(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if row.phase != "summary-unconfirmed" {
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
    let result = match encode(complete, "summary-confirmed") {
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
public flow admit(row: work_record_Record) -> Result<bool, string> {
    let captured = match validate(row) {
        Ok(value) => value,
        Err(error) => {
            return Err(error);
        }
    };
    if row.phase != "summary-unconfirmed" {
        return Err("work admission requires an unconfirmed candidate");
    }
    let sentinel = "\"" + from_char('\\') + "u0001\"";
    let parsed = match parse(sentinel) {
        Ok(value) => value,
        Err(_) => {
            return Err("work admission sentinel decode refused");
        }
    };
    let message = Message.new(parsed);
    let converted: Option<Message<string>> = message.cast<string>();
    let control = match converted {
        Some(value) => value.body,
        None() => {
            return Err("work admission sentinel conversion refused");
        }
    };
    let control_bytes = utf8_encode(control);
    if bytes_len(control_bytes) != 1 {
        return Err("work admission sentinel must be exactly one UTF-8 byte");
    }
    let expected: u8 = 1;
    if control_bytes[0] != expected {
        return Err("work admission sentinel must be U+0001");
    }
    var summary = "";
    var index: usize = 0;
    @limits([Iterations(512)]) while index < 512 {
        summary = summary + control;
        index = index + 1;
    }
    let hypothetical = captured {
        summary,
        ledger = stage(true, captured.evidence.ledger)
    };
    return match encode(hypothetical, "summary-confirmed") {
        Ok(_) => Ok(true),
        Err(error) => Err(error)
    };
}

public flow same_record(left: work_record_Record, right: work_record_Record) -> bool {
    return left == right;
}

public type Failure = {
    state: Ledger,
    error: string
};

public type Pending = {
    selected: Selector,
    prepared: Prepared,
    evidence: Evidence,
    request: string,
    task: string,
    state: Ledger,
    high_input: bool
};

public type Completed = {
    context: Context,
    state: Ledger,
    high_input: bool
};

public type Summary = {
    answer: string,
    state: Ledger,
    model_generated: bool
};
