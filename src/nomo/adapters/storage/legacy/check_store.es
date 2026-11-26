module nomo.adapters.storage.legacy.check_store;

import std.memory.{MemoryEntry, MemoryVersion, Missing};
import std.memory.WriteCondition;
import nomo.domain.sessions.redaction.Policy;
import nomo.application.sessions.ports.session_cas_rows.CasRows;
import nomo.application.sessions.persistence.commit_once;
import nomo.domain.sessions.event_text_codec.{encode_prefix, decode};
import nomo.session.history_check_store.Record;
import nomo.adapters.storage.legacy.history_check_guard.invalid as invalid_check;
import nomo.session.history_work_guard.Record as Work;
import nomo.application.sessions.ports.session_check_store.CheckAccess;
import nomo.session.check_store.Frame;

public flow invalid(value: Frame, policy: Policy, binding: string) -> string {
    if value.format != 1 || value.policy_binding != binding || value.work_history == "" || value.workspace == "" || value.path == "" { return "invalid recoverable check binding"; }
    let error = invalid_check(value.check); if error != "" { return error; }
    if value.check.phase != "complete" {
        if value.stdout != "" || value.stderr != "" || value.stdout_truncated || value.stderr_truncated { return "unfinished check has output"; }
    } else {
        match decode(value.stdout, policy) { Ok(_) => (), Err(problem) => { return problem; } }
        match decode(value.stderr, policy) { Ok(_) => (), Err(problem) => { return problem; } }
    }
    return "";
}

public flow load_rows<A ~ CheckAccess>(row: Option<MemoryEntry<string, Frame>>, access: A, policy: Policy, binding: string) -> Result<Option<MemoryEntry<string, Frame>>, string> {
    let work = match access.work() { Ok(Some(item)) => item, Ok(None()) => { if row != None() { return Err("check exists without work"); } return Ok(None()); } Err(problem) => { return Err(problem); } };
    match row {
        Some(item) => {
            let error = invalid(item.value, policy, binding); if error != "" { return Err(error); }
            let saved = item.value;
            if item.key != "check" || saved.check.id != work.id || saved.workspace != work.workspace || saved.path != work.path || saved.work_history != work.history_version { return Err("check and work bindings differ"); }
            if saved.check.phase != "planned" {
                if work.phase != "complete" { return Err("check requires completed work"); }
                let edit = access.completed_edit(saved.check.id, saved.workspace, saved.path);
                if edit != "" { return Err(edit); }
            }
        }
        None() => (),
    }
    return Ok(row);
}

public flow write_rows<R ~ CasRows<Frame>>(rows: R, value: Frame, expected: Option<MemoryEntry<string, Frame>>, policy: Policy, binding: string) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(value, policy, binding); if error != "" { return Err(error); }
    let before = match rows.read() { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("recoverable check changed; no retry"); }
    let condition: WriteCondition = match expected { Some(item) => WriteCondition.Match(item.version), None() => Missing };
    let previous = match expected { Some(item) => Some(item.version), None() => None() };
    return commit_once<Frame, R>(rows, value, condition, previous);
}

public flow plan_rows<R ~ CasRows<Frame>>(rows: R, work: Work, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    match rows.read() { Ok(None()) => (), Ok(Some(_)) => { return Err("check already planned; no retry"); } Err(error) => { return Err(error); } }
    let record = Record { format = 1, phase = "planned", id = work.id, digest, outcome = "", exit_code = "" };
    let frame = Frame { format = 1, policy_binding = binding, work_history = work.history_version, workspace = work.workspace, path = work.path, check = record, stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false };
    match write_rows(rows, frame, None(), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow start_rows<R ~ CasRows<Frame>, A ~ CheckAccess>(rows: R, access: A, id: string, digest: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match rows.read() { Ok(Some(item)) => item, _ => { return Err("planned check missing or invalid"); } };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "planned" { return Err("planned check differs; no retry"); }
    let work = match access.work() { Ok(Some(item)) => item, _ => { return Err("completed work missing"); } };
    if work.phase != "complete" { return Err("completed work required"); }
    let edit = access.completed_edit(id, old.workspace, old.path);
    if edit != "" { return Err(edit); }
    let record = Record { format = 1, phase = "running", id, digest, outcome = "", exit_code = "" };
    let frame = old {
        format = 1,
        policy_binding = binding,
        check = record,
        stdout = "",
        stderr = "",
        stdout_truncated = false,
        stderr_truncated = false
    };
    match write_rows(rows, frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow finish_rows<R ~ CasRows<Frame>>(rows: R, id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match rows.read() { Ok(Some(item)) => item, _ => { return Err("running check missing or invalid"); } };
    let old = before.value;
    if old.check.id != id || old.check.digest != digest || old.check.phase != "running" { return Err("running check differs; no retry"); }
    let out = match encode_prefix(stdout, out_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let err = match encode_prefix(stderr, err_truncated, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
    let record = Record { format = 1, phase = "complete", id, digest, outcome, exit_code };
    let frame = old {
        format = 1,
        policy_binding = binding,
        check = record,
        stdout = out.value,
        stderr = err.value,
        stdout_truncated = out.truncated,
        stderr_truncated = err.truncated
    };
    match write_rows(rows, frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

public flow abandon_rows<R ~ CasRows<Frame>>(rows: R, id: string, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let before = match rows.read() { Ok(Some(item)) => item, _ => { return Err("running check missing"); } }; let old = before.value;
    if old.check.id != id || old.check.phase != "running" { return Err("interrupted check identity or phase differs"); }
    let record = old.check { phase = "abandoned", outcome = "", exit_code = "" };
    let frame = old { check = record };
    return match write_rows(rows, frame, Some(before), policy, binding) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
