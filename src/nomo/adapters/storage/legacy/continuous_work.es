module nomo.adapters.storage.legacy.continuous_work;

import nomo.domain.sessions.cas_rows.Target;
import nomo.adapters.storage.legacy.cas_rows.commit_native;
import std.memory.{Missing};
import std.memory.WriteCondition;
import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;
import nomo.domain.sessions.redaction.{Policy, text as redact};
import nomo.domain.sessions.event_text_codec.encode_prefix;
import nomo.domain.sessions.recoverable_events.work_batch;
import nomo.harness.harness_work_contract.Ledger;
import nomo.domain.harness.harness_work_contract.{ledger_error, native_budget};
import nomo.domain.context.large_context.compatible_scan_i32;
import nomo.session.continuous_work.{Core, Edit, ResultData, Check, Entry, Book, Books};
import nomo.domain.sessions.continuous_work.Stored;

public flow load(binding: string) -> Result<Option<Stored>, string> {
    let row = Books.Rows.get_entry("latest");
    match row { Some(item) => { if item.key != "latest" || item.value.binding != binding { return Err("continuous work policy binding mismatch"); } }, None() => (), }
    return match row { Some(item) => Ok(Some(Stored { key = item.key, value = item.value, version = item.version })), None() => Ok(None()) };
}

flow write(book: Book, previous: Option<Stored>) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let condition: WriteCondition = match previous { Some(item) => WriteCondition.Match(item.version), None() => Missing };
    let target = Target { store = ["Rows"], region = "nomo-continuous-work-v1", key = "latest", label = "continuous work" };
    let version = match commit_native(Books.Rows, target, book, condition) { Ok(value) => value, Err(error) => { return Err(error); } };
    match previous { Some(item) => { if item.version.opaque == version.opaque { return Err("continuous work version did not change"); } }, None() => (), }
    return Ok(Stored { key = "latest", value = book, version });
}

flow put(previous: Stored, item: Entry) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return write(previous.value { current = item }, Some(previous));
}

public flow admit(binding: string, id: string, workspace: string, path: string, request: string, digest: string, policy: Policy, wide: bool, high_input: bool) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let previous = match load(binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    var history: Array<Entry> = [];
    match previous { Some(item) => {
        let last = item.value.current;
        if last.result.phase == "abandoned" { if last.check.phase != "none" && last.check.phase != "planned" { return Err("abandoned check unresolved"); } }
        else if last.result.phase != "complete" || (last.check.phase != "none" && last.check.phase != "complete" && last.check.phase != "abandoned") { return Err("previous work or check is unfinished"); }
        history = item.value.history.push(last);
    } None() => (), }
    if history.len() >= 48 { return Err("continuous session history limit reached"); }
    @limits([Iterations(48)]) for item in history { if item.core.id == id { return Err("work ID already used"); } }
    @limits([Iterations(3)]) for field in [id, workspace, path] {
        let value = match redact(field, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
        if value.replacements != 0 { return Err("work identity contains a known sensitive literal"); }
    }
    let clean = match redact(request, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    let item = Entry { core = Core { id, request = clean }, edit = Edit { phase = "none", binding = None() },
        result = ResultData { phase = "running", summary = "", source = if high_input { "high-input-v2" } else { if wide { "wide-v5" } else { "v2" } }, calls = 0, generation = 0, events = [] },
        check = Check { phase = if digest == "" { "none" } else { "planned" }, digest, outcome = "", exit_code = "", stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false } };
    return write(Book { binding, history, current = item }, previous);
}

public flow edit_intent(ticket: Stored, binding: Binding) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let item = ticket.value.current;
    if item.result.phase != "running" || item.edit.phase != "none" || binding.id != item.core.id { return Err("work edit changed"); }
    return put(ticket, item { edit = Edit { phase = "intent", binding = Some(binding) } });
}

public flow edit_complete(ticket: Stored) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let item = ticket.value.current; if item.edit.phase != "intent" { return Err("work edit intent missing"); }
    return put(ticket, item { edit = item.edit { phase = "completed" } });
}

public flow finish(ticket: Stored, summary: string, source: string, spent: Ledger, records: Array<Event>, policy: Policy) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let item = ticket.value.current; if item.edit.phase != "completed" || item.result.phase != "running" { return Err("completed work edit required"); }
    if ledger_error(spent) != "" || spent.read.calls + spent.edit.calls != 7 || spent.read.tokens + spent.edit.tokens != (if item.result.source == "wide-v5" || item.result.source == "wide-v4" { 286720 } else { if item.result.source == "high-input-v2" { 917504 } else { if item.result.source == "wide-v3" || item.result.source == "high-input-v1" { 188416 } else { if item.result.source == "wide" || item.result.source == "wide-v2" { 61440 } else { 51200 } } } }) { return Err("additional work ledger differs from reservation"); }
    // High-input sources store their 6M configured run ceiling durably;
    // native_budget remains the compatible stage-shape counter, not usage.
    if (item.result.source == "wide-v5" || item.result.source == "wide-v4" || item.result.source == "wide-v3" || item.result.source == "wide-v2" || item.result.source == "v2" || item.result.source == "high-input-v1" || item.result.source == "high-input-v2") && (native_budget(spent) != (if item.result.source == "high-input-v2" { 7340032 } else { if item.result.source == "wide-v5" || item.result.source == "wide-v4" { 2811008 } else { if item.result.source == "wide-v3" || item.result.source == "high-input-v1" { 2073152 } else { 1335296 } } }) || !(if item.result.source == "wide-v5" || item.result.source == "high-input-v1" || item.result.source == "high-input-v2" { compatible_scan_i32(spent.read.scan) } else { spent.read.scan == 65540 })) { return Err("additional work native reservation differs"); }
    let cleaned = match redact(summary, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    let saved = match work_batch(records, policy) { Ok(value) => value.events, Err(error) => { return Err(error); } };
    let result = ResultData { phase = "complete", summary = cleaned, source = if item.result.source == "high-input-v2" { source + "-high-input-v2" } else { if item.result.source == "high-input-v1" { source + "-high-input" } else { if item.result.source == "wide-v5" { source + "-v5" } else { if item.result.source == "wide-v4" { source + "-v4" } else { if item.result.source == "wide-v3" { source + "-v3" } else { if item.result.source == "wide-v2" || item.result.source == "v2" { source + "-v2" } else { source } } } } } }, calls = spent.read.calls + spent.edit.calls, generation = spent.read.tokens + spent.edit.tokens, events = saved };
    return put(ticket, item { result });
}

public flow start_check(binding: string, id: string, digest: string) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(item)) => item, _ => { return Err("work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.result.phase != "complete" || item.check.phase != "planned" || item.check.digest != digest { return Err("planned check missing"); }
    let check = Check { phase = "running", digest, outcome = "", exit_code = "", stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false };
    return put(row, item { check });
}

public flow finish_check(binding: string, id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>, Error<BudgetExceeded>] {
    let row = match load(binding) { Ok(Some(item)) => item, _ => { return Err("work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.check.phase != "running" || item.check.digest != digest { return Err("running check missing"); }
    let out = match encode_prefix(stdout, out_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let err = match encode_prefix(stderr, err_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let check = Check { phase = "complete", digest, outcome, exit_code, stdout = out.value, stderr = err.value, stdout_truncated = out.truncated, stderr_truncated = err.truncated };
    return put(row, item { check });
}

public flow abandon(binding: string, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(value)) => value, _ => { return Err("interrupted work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.result.phase != "running" || (item.check.phase != "none" && item.check.phase != "planned") { return Err("interrupted work identity or phase differs"); }
    let result = item.result { phase = "abandoned" };
    return match put(row, item { result }) { Ok(_) => Ok(true), Err(error) => Err(error) };
}

public flow abandon_check(binding: string, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(value)) => value, _ => { return Err("interrupted check missing"); } }; let item = row.value.current;
    if item.core.id != id || item.result.phase != "complete" || item.check.phase != "running" { return Err("interrupted check identity or phase differs"); }
    let check = item.check { phase = "abandoned" };
    return match put(row, item { check }) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
