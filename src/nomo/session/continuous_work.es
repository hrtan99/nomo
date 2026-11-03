module nomo.session.continuous_work;

import std.memory.{get_entry, prepare_put, operation_ref, commit, MemoryEntry, MemoryVersion, WriteCondition, WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import std.collections.len as count;
import nomo.core.conversation.Event;
import nomo.session.edit_operation.Binding;
import nomo.session.redaction.{Policy, text as redact};
import nomo.session.event_text_codec.{encode, encode_prefix};
import nomo.session.recoverable_events.{empty, append};
import nomo.harness.harness_work_contract.Ledger;

// All additional rounds share one append-only history and one current slot.
// Each current edit/check transition is durable before its external effect.
public type Core = { id: string, request: string };
public type Edit = { phase: string, binding: Option<Binding> };
public type ResultData = { phase: string, summary: string, source: string, calls: i32, generation: i32, events: Array<Event> };
public type Check = { phase: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, stdout_truncated: bool, stderr_truncated: bool };
public type Entry = { core: Core, edit: Edit, result: ResultData, check: Check };
public type Book = { binding: string, history: Array<Entry>, current: Entry };
public type Stored = { key: string, value: Book, version: MemoryVersion };
alias Schema = MemoryRegion<{ Rows: Store<string, Book> }>;
let Books = std.memory.region<Schema>(stable_id = "nomo-continuous-work-v1", store = "continuous-work");

public flow load(binding: string) -> Result<Option<Stored>, string> {
    let row = get_entry(Books.Rows, "latest");
    match row { Some(item) => { if item.key != "latest" || item.value.binding != binding { return Err("continuous work policy binding mismatch"); } } None() => {} }
    return match row { Some(item) => Ok(Some(Stored { key = item.key, value = item.value, version = item.version })), None() => Ok(None()) };
}
flow write(book: Book, previous: Option<Stored>) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let condition: WriteCondition = match previous { Some(item) => Match(item.version), None() => Missing };
    let intent = prepare_put(Books.Rows, "latest", book, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) { WriteOutcome.Committed(item) => item, _ => { return Err("continuous work commit not confirmed"); } };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint || receipt.target.key != "latest" { return Err("continuous work receipt mismatch"); }
    match receipt.durability { StorageDurability.SqliteWalFull() => {} _ => { return Err("durable work storage required"); } }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("work version missing"); } };
    let after = match load(book.binding) { Ok(Some(item)) => item, _ => { return Err("work readback missing"); } };
    if after.value != book || after.version.opaque != version.opaque { return Err("work readback mismatch"); }
    return Ok(after);
}
flow put(previous: Stored, item: Entry) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    return write(Book { binding = previous.value.binding, history = previous.value.history, current = item }, Some(previous));
}
public flow admit(binding: string, id: string, workspace: string, path: string, request: string, digest: string, policy: Policy) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let previous = match load(binding) { Ok(item) => item, Err(error) => { return Err(error); } };
    var history: Array<Entry> = [];
    match previous { Some(item) => {
        let last = item.value.current;
        if last.result.phase == "abandoned" { if last.check.phase != "none" && last.check.phase != "planned" { return Err("abandoned check unresolved"); } }
        else if last.result.phase != "complete" || (last.check.phase != "none" && last.check.phase != "complete") { return Err("previous work or check is unfinished"); }
        history = item.value.history.push(last);
    } None() => {} }
    if count(history) >= 32 { return Err("continuous session history limit reached"); }
    for item in history limit Iterations(32) { if item.core.id == id { return Err("work ID already used"); } }
    for field in [id, workspace, path] limit Iterations(3) {
        let value = match redact(field, policy) { Ok(item) => item, Err(error) => { return Err(error); } };
        if value.replacements != 0 { return Err("work identity contains a known sensitive literal"); }
    }
    let clean = match redact(request, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    let item = Entry { core = Core { id = id, request = clean }, edit = Edit { phase = "none", binding = None() },
        result = ResultData { phase = "running", summary = "", source = "", calls = 0, generation = 0, events = [] },
        check = Check { phase = if digest == "" { "none" } else { "planned" }, digest = digest, outcome = "", exit_code = "", stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false } };
    return write(Book { binding = binding, history = history, current = item }, previous);
}
public flow edit_intent(ticket: Stored, binding: Binding) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let item = ticket.value.current;
    if item.result.phase != "running" || item.edit.phase != "none" || binding.id != item.core.id { return Err("work edit changed"); }
    return put(ticket, Entry { core = item.core, edit = Edit { phase = "intent", binding = Some(binding) }, result = item.result, check = item.check });
}
public flow edit_complete(ticket: Stored) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let item = ticket.value.current; if item.edit.phase != "intent" { return Err("work edit intent missing"); }
    return put(ticket, Entry { core = item.core, edit = Edit { phase = "completed", binding = item.edit.binding }, result = item.result, check = item.check });
}
public flow finish(ticket: Stored, summary: string, source: string, spent: Ledger, records: Array<Event>, policy: Policy) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let item = ticket.value.current; if item.edit.phase != "completed" || item.result.phase != "running" { return Err("completed work edit required"); }
    let cleaned = match redact(summary, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
    var encoded: Array<Event> = [];
    for event in records limit Iterations(24) {
        let text = match encode(event.text, policy) { Ok(value) => value.value, Err(error) => { return Err(error); } };
        encoded = encoded.push(Event { role = event.role, kind = event.kind, name = event.name, text = text });
    }
    let saved = match append(empty(), 1, encoded, policy) { Ok(value) => value.frame.events, Err(error) => { return Err(error); } };
    let result = ResultData { phase = "complete", summary = cleaned, source = source, calls = spent.read.calls + spent.edit.calls, generation = spent.read.tokens + spent.edit.tokens, events = saved };
    return put(ticket, Entry { core = item.core, edit = item.edit, result = result, check = item.check });
}
public flow start_check(binding: string, id: string, digest: string) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(item)) => item, _ => { return Err("work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.result.phase != "complete" || item.check.phase != "planned" || item.check.digest != digest { return Err("planned check missing"); }
    let check = Check { phase = "running", digest = digest, outcome = "", exit_code = "", stdout = "", stderr = "", stdout_truncated = false, stderr_truncated = false };
    return put(row, Entry { core = item.core, edit = item.edit, result = item.result, check = check });
}
public flow finish_check(binding: string, id: string, digest: string, outcome: string, exit_code: string, stdout: string, stderr: string, out_truncated: bool, err_truncated: bool, policy: Policy) -> Result<Stored, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(item)) => item, _ => { return Err("work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.check.phase != "running" || item.check.digest != digest { return Err("running check missing"); }
    let out = match encode_prefix(stdout, out_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let err = match encode_prefix(stderr, err_truncated, policy) { Ok(value) => value, Err(error) => { return Err(error); } };
    let check = Check { phase = "complete", digest = digest, outcome = outcome, exit_code = exit_code, stdout = out.value, stderr = err.value, stdout_truncated = out.truncated, stderr_truncated = err.truncated };
    return put(row, Entry { core = item.core, edit = item.edit, result = item.result, check = check });
}

public flow abandon(binding: string, id: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let row = match load(binding) { Ok(Some(value)) => value, _ => { return Err("interrupted work missing"); } }; let item = row.value.current;
    if item.core.id != id || item.result.phase != "running" || (item.check.phase != "none" && item.check.phase != "planned") { return Err("interrupted work identity or phase differs"); }
    let result = ResultData { phase = "abandoned", summary = item.result.summary, source = item.result.source, calls = item.result.calls, generation = item.result.generation, events = item.result.events };
    return match put(row, Entry { core = item.core, edit = item.edit, result = result, check = item.check }) { Ok(_) => Ok(true), Err(error) => Err(error) };
}
