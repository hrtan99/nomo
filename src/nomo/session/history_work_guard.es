module nomo.session.history_work_guard;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.chat_session_contract.Session;
import nomo.session.chat_history.{Entry, load as load_chat};
import nomo.session.edit_operation.selector_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.harness_edit_contract.history_summary_error;
import std.text.len;
import nomo.harness.harness_work_contract.{Ledger, ledger_error, native_tokens};

// This record prevents a second dispatched work request for this session.
// It is not a File receipt, root identity, user approval, or Host witness.
public type Budget = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };
public type Record = { format: i32, phase: string, id: string, workspace: string, path: string,
    request: string, history_version: string, reserved: Budget, settled: Option<Ledger>, summary: string };
flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }
flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }
public type Ticket = { record: Record, version: MemoryVersion, history: Entry };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Runs = std.memory.region<Schema>(stable_id = "nomo-history-work-v1", store = "history-work");
flow read() -> Option<MemoryEntry<string, Record>> { return get_entry(Runs.Rows, "work"); }
public flow invalid(value: Record) -> string {
    if (value.format != 1 && value.format != 2) || (value.phase != "running" && value.phase != "complete" && value.phase != "abandoned") { return "invalid history-work phase"; }
    let selected = selector_error(value.id, value.workspace, value.path); if selected != "" { return selected; }
    let question = question_error(value.request); if question != "" { return question; }
    if value.history_version == "" || len(value.history_version) > 512 { return "invalid history version"; }
    if value.phase == "running" || value.phase == "abandoned" {
        let expected = if value.format == 1 { full() } else { Budget { steps = 13, calls = 7, generation = 51200, native_tokens = 196608 } };
        if value.summary != "" || value.reserved != expected || value.settled != None() { return "invalid running work reservation"; }
    } else {
        if history_summary_error(value.summary, "summary") != "" || value.reserved != zero() { return "invalid completed work summary or reservation"; }
        let spent = match value.settled { Some(item) => item, None() => { return "missing settled work ledger"; } };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls + spent.edit.calls != 7 ||
            spent.read.tokens + spent.edit.tokens != (if value.format == 1 { 47104 } else { 51200 }) || native_tokens(spent) != 196608 { return "invalid settled work ledger"; }
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
    let intent = prepare_put(Runs.Rows, "work", row, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("history-work commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("history-work commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "work" || receipt.target.region != "nomo-history-work-v1" || receipt.target.store != ["Rows"] {
        return Err("history-work receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite history-work receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value, _ => { return Err("history-work version required"); } };
    let after = match read() { Some(value) => value, None() => { return Err("history-work readback missing"); } };
    if after.key != "work" || after.value != row || after.version.opaque != version.opaque { return Err("history-work readback mismatch; no retry"); }
    return Ok(version);
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
