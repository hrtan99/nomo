module nomo.session.history_followup_check_guard;

import nomo.session.cas_rows.{Target, commit_native};

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
    return commit_native<Record>(Checks.Rows, Target { store = ["Rows"], region = "nomo-followup-check-v1", key = "check", label = "history-check" }, row, condition);
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
flow transition(id: string, digest: string, outcome: string, exit_code: string, finishing: bool) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let proof = confirmed_work(id); if proof != "" { return Err(proof); }
    let before = match read() { Some(value) => value, None() => { return Err(if finishing { "running check missing" } else { "planned check missing" }); } };
    let error = invalid(before.value); if error != "" { return Err(error); }
    if before.key != "check" || before.value.id != id || before.value.digest != digest || before.value.phase != (if finishing { "running" } else { "planned" }) { return Err(if finishing { "running check differs; no retry" } else { "planned check differs; no retry" }); }
    let row = Record { format = 1, phase = if finishing { "complete" } else { "running" }, id = id, digest = digest, outcome = outcome, exit_code = exit_code };
    let version = match write(row, Match(before.version)) { Ok(value) => value, Err(problem) => { return Err(problem); } };
    if version.opaque == before.version.opaque { return Err("check version did not change"); }
    return Ok(true);
}
public flow start(id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return transition(id, digest, "", "", false); }
public flow finish(id: string, digest: string, outcome: string, exit_code: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return transition(id, digest, outcome, exit_code, true); }
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
