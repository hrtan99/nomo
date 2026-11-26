module nomo.adapters.storage.legacy.check_output;

import nomo.domain.context.large_context.message_frame_bytes;
import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import std.memory.Missing;
import std.text.char_count as len;
import nomo.adapters.storage.legacy.history_check_guard.inspect as inspect_first;
import nomo.adapters.storage.legacy.history_followup_check_guard.inspect as inspect_followup;
import nomo.session.check_output.{Record, Outputs};

flow check_binding(slot: string, id: string, digest: string) -> string {
    if slot == "first" {
        let value = match inspect_first() { Ok(Some(item)) => item, _ => { return "completed first check required"; } };
        if value.phase != "complete" || value.id != id || value.digest != digest { return "first check binding differs"; }
    } else if slot == "followup" {
        let value = match inspect_followup() { Ok(Some(item)) => item, _ => { return "completed followup check required"; } };
        if value.phase != "complete" || value.id != id || value.digest != digest { return "followup check binding differs"; }
    } else { return "unknown check output slot"; }
    return "";
}

public flow save(value: Record) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    if value.format != 1 || len(value.stdout) > message_frame_bytes() || len(value.stderr) > message_frame_bytes() { return Err("invalid check output"); }
    let problem = check_binding(value.slot, value.id, value.digest); if problem != "" { return Err(problem); }
    if Outputs.Rows.get_entry(value.slot) != None() { return Err("check output already recorded"); }
    match commit_native<Record>(Outputs.Rows, Target { store = ["Rows"], region = "nomo-check-output-v1", key = value.slot, label = "check output" }, value, Missing) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow load(slot: string, id: string, digest: string) -> Result<Option<Record>, string> {
    let problem = check_binding(slot, id, digest); if problem != "" { return Err(problem); }
    let saved = Outputs.Rows.get_entry(slot);
    match saved {
        None() => { return Ok(None()); }
        Some(entry) => {
            let value = entry.value;
            if value.format != 1 || value.slot != slot || value.id != id || value.digest != digest || len(value.stdout) > message_frame_bytes() || len(value.stderr) > message_frame_bytes() {
                return Err("check output record differs");
            }
            if Outputs.Rows.get_entry(slot) != saved { return Err("check output changed during read"); }
            return Ok(Some(value));
        }
    }
}
