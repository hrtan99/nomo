module nomo.session.history_followup_check_guard;

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.cas_rows.{Target, commit_native};
public import nomo.session.history_check_store.Record;
import nomo.session.history_check_store.{HistoryCheckRows, plan as plan_rows, start as start_rows, finish as finish_rows, inspect as inspect_rows};
import nomo.session.history_followup_guard.{Ticket, claim, inspect as inspect_work};
import nomo.session.history_followup_edit_store.inspect as inspect_edit;

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Checks = std.memory.region<Schema>(stable_id = "nomo-followup-check-v1", store = "followup-check");
type FollowupCheckRows = {};
impl FollowupCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> { return get_entry(Checks.Rows, "check"); }
    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> { return commit_native<Record>(Checks.Rows, Target { store = ["Rows"], region = "nomo-followup-check-v1", key = "check", label = "history-check" }, row, condition); }
    flow confirmed_work(self, id: string) -> string {
        let work = match inspect_work() { Ok(Some(value)) => value, _ => { return "completed work record required"; } };
        if work.phase != "complete" || work.id != id { return "completed work identity required"; }
        let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return "completed edit record required"; } };
        return if edit.phase == "completed" { "" } else { "completed edit record required" };
    }
    flow recorded_work_id(self) -> Result<string, string> { return match inspect_work() { Ok(Some(value)) => Ok(value.id), _ => Err("history-check has no work record") }; }
    flow allow_abandoned(self) -> bool ![] { return false; }
}
flow rows() -> FollowupCheckRows { return FollowupCheckRows {}; }
public flow plan(ticket: Ticket, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket) { Ok(_) => plan_rows(rows(), ticket.record.id, digest), Err(error) => Err(error) }
}
public flow start(id: string, digest: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return start_rows(rows(), id, digest); }
public flow finish(id: string, digest: string, outcome: string, exit_code: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return finish_rows(rows(), id, digest, outcome, exit_code); }
public flow inspect() -> Result<Option<Record>, string> { return inspect_rows(rows()); }
