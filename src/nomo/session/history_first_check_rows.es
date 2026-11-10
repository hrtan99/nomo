module nomo.session.history_first_check_rows;

import std.memory.{get_entry, WriteCondition, MemoryVersion, MemoryEntry};
import nomo.session.cas_rows.{Target, commit_native};
import nomo.session.history_check_store.{Record, HistoryCheckRows};
import nomo.session.history_work_guard.inspect as inspect_work;
import nomo.session.edit_operation_store.inspect as inspect_edit;

alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Checks = std.memory.region<Schema>(stable_id = "nomo-history-check-v1", store = "history-check");
public type FirstCheckRows = {};
impl FirstCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> { return get_entry(Checks.Rows, "check"); }
    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> { return commit_native<Record>(Checks.Rows, Target { store = ["Rows"], region = "nomo-history-check-v1", key = "check", label = "history-check" }, row, condition); }
    flow confirmed_work(self, id: string) -> string {
        let work = match inspect_work() { Ok(Some(value)) => value, _ => { return "completed work record required"; } };
        if work.phase != "complete" || work.id != id { return "completed work identity required"; }
        let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return "completed edit record required"; } };
        return if edit.phase == "completed" { "" } else { "completed edit record required" };
    }
    flow recorded_work_id(self) -> Result<string, string> { return match inspect_work() { Ok(Some(value)) => Ok(value.id), _ => Err("history-check has no work record") }; }
    flow allow_abandoned(self) -> bool ![] { return true; }
}
public flow rows() -> FirstCheckRows { return FirstCheckRows {}; }
