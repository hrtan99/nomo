module nomo.adapters.storage.legacy.history_first_check_rows;

import std.memory.{WriteCondition, MemoryVersion, MemoryEntry};
import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import nomo.session.history_check_store.Record;
import nomo.application.sessions.ports.session_history_check_store.HistoryCheckRows;
import nomo.adapters.storage.legacy.history_work_guard.inspect as inspect_work;
import nomo.adapters.storage.legacy.edit_operation_store.inspect as inspect_edit;
import nomo.session.history_first_check_rows.Checks;

public type FirstCheckRows = {};

impl FirstCheckRows ~ HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> { return Checks.Rows.get_entry("check"); }
    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] { return commit_native<Record>(Checks.Rows, Target { store = ["Rows"], region = "nomo-history-check-v1", key = "check", label = "history-check" }, row, condition); }
    flow confirmed_work(self, id: string) -> string {
        let work = match inspect_work() { Ok(Some(value)) => value, _ => { return "completed work record required"; } };
        if work.phase != "complete" || work.id != id { return "completed work identity required"; }
        let edit = match inspect_edit(work.id, work.workspace, work.path) { Ok(Some(value)) => value, _ => { return "completed edit record required"; } };
        return if edit.phase == "completed" { "" } else { "completed edit record required" };
    }
    flow recorded_work_id(self) -> Result<string, string> { return match inspect_work() { Ok(Some(value)) => Ok(value.id), _ => Err("history-check has no work record") }; }
    flow allow_abandoned(self) -> bool ![] { return true; }
}
