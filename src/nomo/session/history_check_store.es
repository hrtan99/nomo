module nomo.session.history_check_store;

import std.memory.{WriteCondition, MemoryVersion, MemoryEntry, Missing, Match};
import std.text.{char_count as len, parse_i32, from_i32};
import nomo.core.text.hex_digest;

public type Record = { format: i32, phase: string, id: string, digest: string, outcome: string, exit_code: string };

public spec HistoryCheckRows {
    flow read(self) -> Option<MemoryEntry<string, Record>> ![Memory, Error<StorageError>, Error<IndexError>];
    flow write(self, row: Record, condition: WriteCondition) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow confirmed_work(self, id: string) -> string ![Memory, Error<StorageError>, Error<IndexError>];
    flow recorded_work_id(self) -> Result<string, string> ![Memory, Error<StorageError>, Error<IndexError>];
    flow allow_abandoned(self) -> bool ![];
}

flow valid_failure_code(value: string) -> bool {
    if len(value) < 1 || len(value) > 3 { return false; }
    return match parse_i32(value) { Ok(number) => number >= 1 && number <= 123 && from_i32(number) == value, Err(_) => false };
}

public flow invalid_values(format: i32, phase: string, id: string, digest: string, outcome: string, exit_code: string, allow_abandoned: bool) -> string {
    if format != 1 || (phase != "planned" && phase != "running" && phase != "complete" && !(allow_abandoned && phase == "abandoned")) || id == "" || !hex_digest(digest) { return "invalid history-check record"; }
    if phase != "complete" {
        if outcome != "" || exit_code != "" { return "unfinished check has an outcome"; }
    } else if !((outcome == "passed" && exit_code == "0") || (outcome == "failed" && valid_failure_code(exit_code))) { return "invalid completed check outcome"; }
    return "";
}

flow invalid<R ~ HistoryCheckRows>(rows: R, value: Record) -> string {
    return invalid_values(value.format, value.phase, value.id, value.digest, value.outcome, value.exit_code, rows.allow_abandoned());
}

flow save<R ~ HistoryCheckRows>(rows: R, value: Record, condition: WriteCondition) -> Result<MemoryVersion, string> {
    let error = invalid(rows, value); if error != "" { return Err(error); }
    return rows.write(value, condition);
}

public flow plan<R ~ HistoryCheckRows>(rows: R, id: string, digest: string) -> Result<bool, string> {
    if rows.read() != None() { return Err("history-check already planned; no retry"); }
    let value = Record { format = 1, phase = "planned", id = id, digest = digest, outcome = "", exit_code = "" };
    match save(rows, value, Missing) { Ok(_) => Ok(true), Err(error) => Err(error) }
}

flow transition<R ~ HistoryCheckRows>(rows: R, id: string, digest: string, outcome: string, exit_code: string, finishing: bool) -> Result<bool, string> {
    let proof = rows.confirmed_work(id); if proof != "" { return Err(proof); }
    let before = match rows.read() { Some(value) => value, None() => { return Err(if finishing { "running check missing" } else { "planned check missing" }); } };
    let error = invalid(rows, before.value); if error != "" { return Err(error); }
    if before.key != "check" || before.value.id != id || before.value.digest != digest || before.value.phase != (if finishing { "running" } else { "planned" }) { return Err(if finishing { "running check differs; no retry" } else { "planned check differs; no retry" }); }
    let value = Record { format = 1, phase = if finishing { "complete" } else { "running" }, id = id, digest = digest, outcome = outcome, exit_code = exit_code };
    let version = match save(rows, value, Match(before.version)) { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if version.opaque == before.version.opaque { return Err("check version did not change"); }
    return Ok(true);
}

public flow start<R ~ HistoryCheckRows>(rows: R, id: string, digest: string) -> Result<bool, string> { return transition(rows, id, digest, "", "", false); }
public flow finish<R ~ HistoryCheckRows>(rows: R, id: string, digest: string, outcome: string, exit_code: string) -> Result<bool, string> { return transition(rows, id, digest, outcome, exit_code, true); }

public flow inspect<R ~ HistoryCheckRows>(rows: R) -> Result<Option<Record>, string> {
    let before = rows.read();
    match before {
        None() => Ok(None()),
        Some(value) => {
            let error = invalid(rows, value.value); if error != "" { return Err(error); }
            let work_id = match rows.recorded_work_id() { Ok(item) => item, Err(problem) => { return Err(problem); } };
            if work_id != value.value.id { return Err("history-check work identity differs"); }
            if value.value.phase != "planned" { let proof = rows.confirmed_work(value.value.id); if proof != "" { return Err(proof); } }
            if value.key != "check" || rows.read() != before { return Err("history-check changed during status"); }
            Ok(Some(value.value))
        }
    }
}
