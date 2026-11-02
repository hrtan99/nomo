module nomo.session.history_followup_guard;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import std.text.len;
import nomo.session.chat_session_contract.Session;
import nomo.session.chat_history.{Entry, load as load_chat};
import nomo.session.history_work_guard.{Record as WorkRecord, inspect as inspect_work};
import nomo.session.history_check_guard.{Record as CheckRecord, inspect as inspect_check};
import nomo.session.edit_operation_store.inspect as inspect_edit;
import nomo.session.edit_operation.{selector_error, Record as EditRecord};
import nomo.model.model_tool_contract.question_error;
import nomo.harness.harness_edit_contract.text_error;
import nomo.harness.harness_work_contract.{Ledger, ledger_error, native_tokens};

// One additional work attempt, with separate reserved budget and fresh grants.
// The predecessor is untrusted recorded context, not a current root witness.
public type Budget = { steps: i32, calls: i32, generation: i32, native_tokens: i32 };
public type Parent = { work: WorkRecord, edit: EditRecord, check: Option<CheckRecord> };
public type Record = { format: i32, phase: string, id: string, workspace: string, path: string, request: string,
    history_version: string, parent: Parent, reserved: Budget, settled: Option<Ledger>, summary: string };
public type Ticket = { record: Record, version: MemoryVersion, history: Entry };
flow full() -> Budget { return Budget { steps = 13, calls = 7, generation = 47104, native_tokens = 196608 }; }
flow zero() -> Budget { return Budget { steps = 0, calls = 0, generation = 0, native_tokens = 0 }; }
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Runs = std.memory.region<Schema>(stable_id = "nomo-history-followup-v1", store = "history-followup");
flow read() -> Option<MemoryEntry<string, Record>> { return get_entry(Runs.Rows, "followup"); }
flow parent() -> Result<Parent, string> {
    let work = match inspect_work() { Ok(Some(value)) => value, _ => { return Err("completed first work required"); } };
    if work.phase != "complete" { return Err("first work is unresolved; inspect without retry"); }
    let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return Err("completed first edit required"); } };
    if edit.phase != "completed" { return Err("first edit is unresolved"); }
    let check = match inspect_check() { Ok(value) => value, Err(error) => { return Err(error); } };
    match check { Some(value) => { if value.phase != "complete" || value.id != work.id { return Err("first check is unresolved"); } } None() => {} }
    return Ok(Parent { work = work, edit = edit, check = check });
}
flow history_error(history: Entry) -> string {
    if history.key != "latest" || history.value.invocation.admitted < 1 || history.value.phase == "running" || history.value.pending != "" { return "completed chat history required"; }
    let actual = match load_chat() { Ok(Some(value)) => value, _ => { return "chat history missing or invalid"; } };
    if actual != history { return "chat history changed; no retry"; }
    return "";
}
flow invalid(row: Record) -> string {
    if row.format != 1 || (row.phase != "running" && row.phase != "complete") { return "invalid followup phase"; }
    let selected = selector_error(row.id, row.workspace, row.path); if selected != "" { return selected; }
    if row.id == row.parent.work.id { return "followup operation ID must differ"; }
    if question_error(row.request) != "" || row.history_version == "" || len(row.history_version) > 512 { return "invalid followup request or history"; }
    if row.phase == "running" {
        if row.summary != "" || row.reserved != full() || row.settled != None() { return "invalid followup reservation"; }
    } else {
        if text_error(row.summary, "summary") != "" || row.reserved != zero() { return "invalid followup completion"; }
        let spent = match row.settled { Some(value) => value, None() => { return "missing followup ledger"; } };
        if ledger_error(spent) != "" || spent.read.steps + spent.edit.steps != 13 || spent.read.calls + spent.edit.calls != 7 ||
            spent.read.tokens + spent.edit.tokens != 47104 || native_tokens(spent) != 196608 { return "invalid followup ledger"; }
    }
    return "";
}
flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(row); if error != "" { return Err(error); }
    let intent = prepare_put(Runs.Rows, "followup", row, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) { WriteOutcome.Unknown(_) => { return Err("followup commit unknown; no retry"); } WriteOutcome.NotCommitted(_, _) => { return Err("followup commit refused; no retry"); } WriteOutcome.Committed(value) => value };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != "followup" ||
        receipt.target.region != "nomo-history-followup-v1" || receipt.target.store != ["Rows"] { return Err("followup receipt mismatch"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false }; if !durable { return Err("durable followup receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value, _ => { return Err("followup version missing"); } };
    let after = match read() { Some(value) => value, None() => { return Err("followup readback missing"); } };
    if after.key != "followup" || after.value != row || after.version.opaque != version.opaque { return Err("followup readback mismatch"); }
    return Ok(version);
}
public flow admit(id: string, workspace: string, path: string, request: string, history: Entry) -> Result<Ticket, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if read() != None() { return Err("followup slot already consumed; no retry"); }
    let error = history_error(history); if error != "" { return Err(error); }
    let prior = match parent() { Ok(value) => value, Err(problem) => { return Err(problem); } };
    let row = Record { format = 1, phase = "running", id = id, workspace = workspace, path = path, request = request,
        history_version = history.version.opaque, parent = prior, reserved = full(), settled = None(), summary = "" };
    let version = match write(row, Missing) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    return Ok(Ticket { record = row, version = version, history = history });
}
public flow claim(ticket: Ticket) -> Result<bool, string> {
    let error = invalid(ticket.record); if error != "" { return Err(error); }
    let h = history_error(ticket.history); if h != "" { return Err(h); }
    let prior = match parent() { Ok(value) => value, Err(problem) => { return Err(problem); } };
    if prior != ticket.record.parent { return Err("first work changed; no retry"); }
    if ticket.record.phase != "running" || ticket.record.history_version != ticket.history.version.opaque { return Err("followup ticket changed"); }
    let actual = match read() { Some(value) => value, None() => { return Err("followup reservation missing"); } };
    if actual.key != "followup" || actual.value != ticket.record || actual.version.opaque != ticket.version.opaque { return Err("followup reservation changed; no retry"); }
    return Ok(true);
}
public flow finish(ticket: Ticket, summary: string, spent: Ledger) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    let old = ticket.record;
    let row = Record { format = 1, phase = "complete", id = old.id, workspace = old.workspace, path = old.path, request = old.request,
        history_version = old.history_version, parent = old.parent, reserved = zero(), settled = Some(spent), summary = summary };
    let version = match write(row, Match(ticket.version)) { Ok(value) => value, Err(error) => { return Err(error); } };
    if version.opaque == ticket.version.opaque { return Err("followup version did not change"); }
    return Ok(true);
}
public flow inspect() -> Result<Option<Record>, string> {
    let before = read();
    match before {
        None() => { return Ok(None()); }
        Some(value) => {
            let error = invalid(value.value); if error != "" { return Err(error); }
            let prior = match parent() { Ok(item) => item, Err(problem) => { return Err(problem); } };
            if value.key != "followup" || value.value.parent != prior || read() != before { return Err("followup status changed or predecessor differs"); }
            return Ok(Some(value.value));
        }
    }
}
