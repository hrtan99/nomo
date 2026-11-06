module nomo.session.history_work_guard;

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import nomo.session.chat_history.{Entry, load as load_chat};
import nomo.session.edit_operation.selector_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.harness_edit_contract.history_summary_error;
import std.text.char_count as len;
import nomo.harness.harness_work_contract.{Ledger, ledger_error, native_tokens, native_budget};
import nomo.core.large_context.compatible_scan_i32;

// This record prevents a second dispatched work request for this session.
// It is not a File receipt, root identity, user approval, or Host witness.
public type Budget = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };
public type Record = { format: i32, phase: string, id: string, workspace: string, path: string,
    request: string, history_version: string, reserved: Budget, settled: Option<Ledger>, summary: string };
flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }
flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }
flow generation(format: i32) -> i32 {
    return if format == 1 { 47104 } else { if format == 7 || format == 8 { 286720 } else { if format == 6 || format == 9 { 188416 } else { if format == 3 || format == 4 { 61440 } else { 51200 } } } };
}
flow configured_native(format: i32) -> i32 {
    return if format == 9 { 6000000 } else { if format == 7 || format == 8 { 2811008 } else { if format == 6 { 2073152 } else { if format >= 4 { 1335296 } else { 196608 } } } };
}
// Ledger fields preserve the configured stage-shape accounting used by older
// records. Format 9 stores its 6M run ceiling in Record.reserved/format; neither
// number is actual provider usage.
flow settled_shape_native(format: i32) -> i32 { return if format == 9 { 2073152 } else { configured_native(format) }; }
flow expected_scan(format: i32, value: i32) -> bool { return if format == 8 || format == 9 { compatible_scan_i32(value) } else { value == 65540 }; }
public type Ticket = { record: Record, version: MemoryVersion, history: Entry };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Runs = std.memory.region<Schema>(stable_id = "nomo-history-work-v1", store = "history-work");
flow read() -> Option<MemoryEntry<string, Record>> { return get_entry(Runs.Rows, "work"); }
public flow invalid(value: Record) -> string {
    if (value.format < 1 || value.format > 9) || (value.phase != "running" && value.phase != "complete" && value.phase != "abandoned") { return "invalid history-work phase"; }
    let selected = selector_error(value.id, value.workspace, value.path); if selected != "" { return selected; }
    let question = question_error(value.request); if question != "" { return question; }
    if value.history_version == "" || len(value.history_version) > 512 { return "invalid history version"; }
    if value.phase == "running" || value.phase == "abandoned" {
        let expected = if value.format == 1 { full() } else { Budget { steps = 13, calls = 7, generation = generation(value.format), native_tokens = configured_native(value.format) } };
        if value.summary != "" || value.reserved != expected || value.settled != None() { return "invalid running work reservation"; }
    } else {
        if history_summary_error(value.summary, "summary") != "" || value.reserved != zero() { return "invalid completed work summary or reservation"; }
        let spent = match value.settled { Some(item) => item, None() => { return "missing settled work ledger"; } };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls + spent.edit.calls != 7 ||
            spent.read.tokens + spent.edit.tokens != generation(value.format) || (if value.format >= 4 { native_budget(spent) != settled_shape_native(value.format) || !expected_scan(value.format, spent.read.scan) } else { native_tokens(spent) != 196608 }) { return "invalid settled work ledger"; }
    }
    return "";
}
flow history_error(history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running" || history.value.pending != "" {
        return "a completed prior chat turn is required";
    }
    let actual = match load_chat() { Ok(Some(value)) => value, _ => { return "chat history missing or invalid"; } };
    if actual != history { return "chat history changed; no retry"; }
    return "";
}
flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(row); if error != "" { return Err(error); }
    return commit_native<Record>(Runs.Rows, Target { store = ["Rows"], region = "nomo-history-work-v1", key = "work", label = "history-work" }, row, condition);
}
public flow admit(id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if read() != None() { return Err("history-work already admitted; no retry"); }
    let error = history_error(history); if error != "" { return Err(error); }
    let row = Record { format = 1, phase = "running", id = id, workspace = workspace, path = path,
        request = request, history_version = history.version.opaque, reserved = full(), settled = None(), summary = "" };
    let version = match write(row, Missing) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    return Ok(Ticket { record = row, version = version, history = history });
}
public flow claim(ticket: Ticket) -> Result<bool, string> {
    let error = invalid(ticket.record); if error != "" { return Err(error); }
    let history = history_error(ticket.history); if history != "" { return Err(history); }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque { return Err("history-work ticket changed"); }
    let actual = match read() { Some(value) => value, None() => { return Err("history-work reservation missing"); } };
    if actual.key != "work" || actual.value != ticket.record || actual.version.opaque != ticket.version.opaque { return Err("history-work reservation changed; no retry"); }
    return Ok(true);
}
public flow finish(ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let old = ticket.record;
    let row = Record { format = 1, phase = "complete", id = old.id, workspace = old.workspace, path = old.path,
        request = old.request, history_version = old.history_version, reserved = zero(), settled = Some(spent), summary = summary };
    let version = match write(row, Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("history-work version did not change"); }
    return Ok(true);
}

public flow chat_available() -> Result<bool, string> {
    return match read() { None() => Ok(true), Some(_) => Err("history-work consumes this session; no chat continuation") };
}

// Status is data only; it is never a current root observation or a grant.
public flow inspect() -> Result<Option<Record>, string> {
    let before = read();
    match before {
        None() => { return Ok(None()); }
        Some(value) => {
            let error = invalid(value.value); if error != "" { return Err(error); }
            if value.key != "work" { return Err("history-work status key mismatch"); }
            if read() != before { return Err("history-work changed during status"); }
            return Ok(Some(value.value));
        }
    }
}
