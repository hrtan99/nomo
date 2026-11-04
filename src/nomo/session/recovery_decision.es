module nomo.session.recovery_decision;

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, MemoryVersion, MemoryEntry, Missing};
import nomo.session.history_work_guard.inspect as inspect_work;
import nomo.session.history_check_guard.inspect as inspect_check;
import nomo.session.history_followup_guard.inspect as inspect_followup;
import nomo.session.history_followup_check_guard.inspect as inspect_followup_check;

// A recorded choice does not prove the side-effect outcome, grant authority,
// release a budget, alter the original record, or authorize a retry.
public type Decision = { format: i32, id: string, target: string, choice: string };
alias Schema = MemoryRegion<{ Rows: Store<string, Decision> }>;
let Decisions = std.memory.region<Schema>(stable_id = "nomo-recovery-decision-v1", store = "recovery-decision");
flow read(target: string) -> Option<MemoryEntry<string, Decision>> { return get_entry(Decisions.Rows, target); }
flow validate_target(target: string, id: string) -> string {
    if target == "followup" || target == "followup-check" {
        let work = match inspect_followup() { Ok(Some(value)) => value, _ => { return "followup work record missing or invalid"; } };
        if id == "" || work.id != id { return "followup work identity differs"; }
        if target == "followup" {
            if work.phase != "running" { return "followup work is not unresolved"; }
        } else {
            let check = match inspect_followup_check() { Ok(Some(value)) => value, _ => { return "followup check record missing or invalid"; } };
            if check.phase != "running" || check.id != id { return "followup check is not unresolved"; }
        }
        return "";
    }
    let work = match inspect_work() { Ok(Some(value)) => value, _ => { return "work record missing or invalid"; } };
    if id == "" || work.id != id { return "work identity differs"; }
    if target == "work" {
        if work.phase != "running" { return "work is not unresolved"; }
    } else if target == "check" {
        let check = match inspect_check() { Ok(Some(value)) => value, _ => { return "check record missing or invalid"; } };
        if check.phase != "running" || check.id != id { return "check is not unresolved"; }
    } else { return "unknown recovery target"; }
    return "";
}
public flow get(target: string) -> Result<Option<Decision>, string> {
    if target != "work" && target != "check" && target != "followup" && target != "followup-check" { return Err("unknown recovery target"); }
    let row = read(target);
    match row {
        None() => { return Ok(None()); }
        Some(value) => {
            let item = value.value;
            if value.key != target || item.format != 1 || item.target != target || item.choice != "abandon" || item.id == "" { return Err("invalid recovery decision"); }
            let error = validate_target(target, item.id); if error != "" { return Err(error); }
            if read(target) != row { return Err("recovery decision changed during inspection"); }
            return Ok(Some(item));
        }
    }
}
public flow abandon(target: string, id: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = validate_target(target, id); if error != "" { return Err(error); }
    if read(target) != None() { return Err("recovery decision already recorded; no retry"); }
    let item = Decision { format = 1, id = id, target = target, choice = "abandon" };
    return commit_native<Decision>(Decisions.Rows, Target { store = ["Rows"], region = "nomo-recovery-decision-v1", key = target, label = "decision" }, item, Missing);
}
