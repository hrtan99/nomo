module nomo.session.check_output;

import nomo.core.large_context.{message_frame_bytes};

import nomo.session.cas_rows.{Target, commit_native};

import std.memory.{get_entry, Missing};
import std.text.char_count as len;
import nomo.session.history_check_guard.inspect as inspect_first;
import nomo.session.history_followup_check_guard.inspect as inspect_followup;

// Output is untrusted diagnostic text, never authority or evidence that a
// command may run again. Records bind to an independently completed check.
public type Record = { format: i32, slot: string, id: string, digest: string,
    stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
alias Schema = MemoryRegion<{ Rows: Store<string, Record> }>;
let Outputs = std.memory.region<Schema>(stable_id = "nomo-check-output-v1", store = "check-output");

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
    if get_entry(Outputs.Rows, value.slot) != None() { return Err("check output already recorded"); }
    match commit_native<Record>(Outputs.Rows, Target { store = ["Rows"], region = "nomo-check-output-v1", key = value.slot, label = "check output" }, value, Missing) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow load(slot: string, id: string, digest: string) -> Result<Option<Record>, string> {
    let problem = check_binding(slot, id, digest); if problem != "" { return Err(problem); }
    let saved = get_entry(Outputs.Rows, slot);
    match saved {
        None() => { return Ok(None()); }
        Some(entry) => {
            let value = entry.value;
            if value.format != 1 || value.slot != slot || value.id != id || value.digest != digest || len(value.stdout) > message_frame_bytes() || len(value.stderr) > message_frame_bytes() {
                return Err("check output record differs");
            }
            if get_entry(Outputs.Rows, slot) != saved { return Err("check output changed during read"); }
            return Ok(Some(value));
        }
    }
}
