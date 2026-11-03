module nomo.session.recoverable_check_store;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion,
    WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.redaction.Policy;
import nomo.session.event_text_codec.{encode_prefix, decode};
import nomo.session.history_check_guard.{Record, invalid as invalid_check};
import nomo.session.recoverable_work_store.{Ticket, claim, load as load_work};
import nomo.session.edit_operation_store.inspect as inspect_edit;

// The planned check is tied to a specific admitted work reservation. The
// running and complete transitions are CAS commits; interruption never retries.
public type Frame = { format: i32, policy_binding: string, work_history: string, workspace: string, path: string,
    check: Record, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
alias Schema = MemoryRegion<{ Rows: Store<string, Frame> }>;
let Checks = std.memory.region<Schema>(stable_id = "nomo-recoverable-check-v1", store = "recoverable-check");

flow invalid(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.work_history == "" || value.workspace == "" || value.path == "" { return "invalid recoverable check binding"; }
    let error = invalid_check(value.check); if error != "" { return error; }
    if value.check.phase != "complete" {
        if value.stdout != "" || value.stderr != "" || value.stdout_truncated || value.stderr_truncated { return "unfinished check has output"; }
    } else {
        match decode(value.stdout, policy) { Ok(_) => {} Err(problem) => { return problem; } }
        match decode(value.stderr, policy) { Ok(_) => {} Err(problem) => { return problem; } }
    }
    return "";
}
public flow load(policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    let row = get_entry(Checks.Rows, "check");
    let work = match load_work(policy, binding) { Ok(Some(item)) => item, Ok(None()) => { if row != None() { return Err("check exists without work"); } return Ok(None()); } Err(problem) => { return Err(problem); } };
    match row {
        Some(item) => {
            let error = invalid(item.value, policy, binding); if error != "" { return Err(error); }
            let saved = item.value;
            if item.key != "check" || saved.check.id != work.value.work.id || saved.workspace != work.value.work.workspace || saved.path != work.value.work.path || saved.work_history != work.value.work.history_version { return Err("check and work bindings differ"); }
            if saved.check.phase != "planned" {
                if work.value.work.phase != "complete" { return Err("check requires completed work"); }
                let edit = match inspect_edit(saved.check.id, saved.workspace, saved.path) { Ok(Some(value)) => value, _ => { return Err("completed edit required"); } };
                if edit.phase != "completed" { return Err("completed edit required"); }
            }
        }
        None() => {}
    }
    return Ok(row);
}
flow write(value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(value, policy, binding); if error != "" { return Err(error); }
    let before = match load(policy, binding) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("recoverable check changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => Match(item.version), None() => Missing };
    let intent = prepare_put(Checks.Rows, "check", value, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) { WriteOutcome.Unknown(_) => { return Err("check commit unknown; no retry"); } WriteOutcome.NotCommitted(_, _) => { return Err("check commit refused; no retry"); } WriteOutcome.Committed(item) => item };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != "check" || receipt.target.region != "nomo-recoverable-check-v1" || receipt.target.store != ["Rows"] { return Err("check receipt mismatch; no retry"); }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false }; if !durable { return Err("durable SQLite check receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("check version missing"); } };
    let after = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("check readback missing"); } };
    if after.value != value || after.version.opaque != version.opaque { return Err("check readback mismatch; no retry"); }
    match expected { Some(item) => { if item.version.opaque == version.opaque { return Err("check version did not change"); } } None() => {} }
    return Ok(version);
}
public flow plan(ticket: Ticket, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match claim(ticket, policy, binding) { Ok(_) => {} Err(error) => { return Err(error); } }
    match load(policy, binding) { Ok(None()) => {} Ok(Some(_)) => { return Err("check already planned; no retry"); } Err(error) => { return Err(error); } }
    let work = ticket.frame.work;
    let record = Record { format = 1, phase = "planned", id = work.id, digest = digest, outcome = "", exit_code = "" };
    let frame = Frame { format = 1, policy_binding = binding, work_history = work.history_version, workspace = work.workspace, path = work.path, check = record, stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false };
    match write(frame, None(), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}
public flow start(id: string, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("planned check missing or invalid"); } };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "planned" { return Err("planned check differs; no retry"); }
    let work = match load_work(policy, binding) { Ok(Some(item)) => item, _ => { return Err("completed work missing"); } };
    if work.value.work.phase != "complete" { return Err("completed work required"); }
    let edit = match inspect_edit(id, old.workspace, old.path) { Ok(Some(item)) => item, _ => { return Err("completed edit required"); } };
    if edit.phase != "completed" { return Err("completed edit required"); }
    let record = Record { format = 1, phase = "running", id = id, digest = digest, outcome = "", exit_code = "" };
    let frame = Frame { format = 1, policy_binding = binding, work_history = old.work_history, workspace = old.workspace, path = old.path, check = record, stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false };
    match write(frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}
public flow finish(id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("running check missing or invalid"); } };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "running" { return Err("running check differs; no retry"); }
    let out = match encode_prefix(stdout, out_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match encode_prefix(stderr, err_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let record = Record { format = 1, phase = "complete", id = id, digest = digest, outcome = outcome, exit_code = exit_code };
    let frame = Frame { format = 1, policy_binding = binding, work_history = old.work_history, workspace = old.workspace, path = old.path, check = record, stdout = out.value, stderr = err.value, stdout_truncated = out.truncated, stderr_truncated = err.truncated };
    match write(frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow abandon(id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match load(policy, binding) { Ok(Some(item)) => item, _ => { return Err("running check missing"); } }; let old = before.value;
    if old.check.id != id || old.check.phase != "running" { return Err("interrupted check identity or phase differs"); }
    let record = Record { format = old.check.format, phase = "abandoned", id = old.check.id, digest = old.check.digest, outcome = "", exit_code = "" };
    let frame = Frame { format = old.format, policy_binding = old.policy_binding, work_history = old.work_history, workspace = old.workspace, path = old.path, check = record, stdout = old.stdout, stderr = old.stderr, stdout_truncated = old.stdout_truncated, stderr_truncated = old.stderr_truncated };
    return match write(frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
