module nomo.session.history_followup_check_guard;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.history_check_guard.invalid_values;
import nomo.session.history_followup_guard.{Ticket, claim, inspect as inspect_work};
import nomo.session.history_followup_edit_store.inspect as inspect_edit;

// Check outcomes describe a launched local command, not current workspace
// identity or proof that arbitrary command side effects were rolled back.
public type Record = { format: i32, phase: string, id: string, digest: string, outcome: string, exit_code: string };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Checks = std.memory.region<Schema>(stable_id = "nomo-followup-check-v1", store = "followup-check");
flow read() -> Option<MemoryEntry<string, Record>> { return get_entry(Checks.Rows, "check"); }
flow invalid(row: Record) -> string { return invalid_values(row.format, row.phase, row.id, row.digest, row.outcome, row.exit_code, false); }
flow write(row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(row); if error != "" { return Err(error); }
    let intent = prepare_put(Checks.Rows, "check", row, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("history-check commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("history-check commit refused; no retry"); }
        WriteOutcome.Committed(value) => value,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "check" || receipt.target.region != "nomo-followup-check-v1" || receipt.target.store != ["Rows"] {
        return Err("history-check receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite history-check receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(value) => value, _ => { return Err("history-check version required"); } };
    let after = match read() { Some(value) => value, None() => { return Err("history-check readback missing"); } };
    if after.key != "check" || after.value != row || after.version.opaque != version.opaque { return Err("history-check readback mismatch; no retry"); }
    return Ok(version);
}
public flow plan(ticket: Ticket, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket) { Ok(_) => {} Err(error) => { return Err(error); } }
    if read() != None() { return Err("history-check already planned; no retry"); }
    let row = Record { format = 1, phase = "planned", id = ticket.record.id, digest = digest, outcome = "", exit_code = "" };
    match write(row, Missing) { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(true);
}
flow confirmed_work(id: string) -> string {
    let work = match inspect_work() { Ok(Some(value)) => value, _ => { return "completed work record required"; } };
    if work.phase != "complete" || work.id != id { return "completed work identity required"; }
    let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return "completed edit record required"; } };
    if edit.phase != "completed" { return "completed edit record required"; }
    return "";
}
public flow start(id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let proof = confirmed_work(id); if proof != "" { return Err(proof); }
    let before = match read() { Some(value) => value, None() => { return Err("planned check missing"); } };
    let error = invalid(before.value); if error != "" { return Err(error); }
    if before.key != "check" || before.value.id != id || before.value.digest != digest || before.value.phase != "planned" { return Err("planned check differs; no retry"); }
    let row = Record { format = 1, phase = "running", id = id, digest = digest, outcome = "", exit_code = "" };
    let version = match write(row, Match(before.version)) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    if version.opaque == before.version.opaque { return Err("check version did not change"); }
    return Ok(true);
}
public flow finish(id: string, digest: string, outcome: string, exit_code: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let proof = confirmed_work(id); if proof != "" { return Err(proof); }
    let before = match read() { Some(value) => value, None() => { return Err("running check missing"); } };
    let error = invalid(before.value); if error != "" { return Err(error); }
    if before.key != "check" || before.value.id != id || before.value.digest != digest || before.value.phase != "running" { return Err("running check differs; no retry"); }
    let row = Record { format = 1, phase = "complete", id = id, digest = digest, outcome = outcome, exit_code = exit_code };
    let version = match write(row, Match(before.version)) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    if version.opaque == before.version.opaque { return Err("check version did not change"); }
    return Ok(true);
}
public flow inspect() -> Result<Option<Record>, string> {
    let before = read();
    match before {
        None() => { return Ok(None()); }
        Some(value) => {
            let error = invalid(value.value); if error != "" { return Err(error); }
            let work = match inspect_work() { Ok(Some(item)) => item, _ => { return Err("history-check has no work record"); } };
            if work.id != value.value.id { return Err("history-check work identity differs"); }
            if value.value.phase != "planned" {
                let proof = confirmed_work(value.value.id); if proof != "" { return Err(proof); }
            }
            if value.key != "check" || read() != before { return Err("history-check changed during status"); }
            return Ok(Some(value.value));
        }
    }
}
