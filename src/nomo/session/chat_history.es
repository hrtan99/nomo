module nomo.session.chat_history;

import std.memory.{get_entry, prepare_put, operation_ref, commit, WriteCondition, MemoryVersion, MemoryEntry,
    WriteOutcome, MemoryWriteChange, StorageDurability, Missing, Match};
import nomo.session.chat_session_contract.{Session, invalid, fresh, begin, complete};
import nomo.harness.harness_tool_chat_contract.{Completed, TurnResult};

// Stored session data is untrusted history, not a workspace identity, current
// grant, proof of an action, or permission to resume an operation.
alias Schema = MemoryRegion<{ Rows: Store<string, Session> }>;
let HistoryStore = std.memory.region<Schema>(stable_id = "nomo-chat-history-v1", store = "chat-history");

flow read_raw() -> Option<MemoryEntry<string, Session>> { return get_entry(HistoryStore.Rows, "latest"); }
public flow load() -> Result<Option<MemoryEntry<string, Session>>, string> {
    let found = read_raw();
    match found {
        Some(entry) => {
            if entry.key != "latest" { return Err("chat history key mismatch"); }
            let error = invalid(entry.value); if error != "" { return Err(error); }
        }
        None() => {}
    }
    return Ok(found);
}

// Check legal transitions independently of the storage version. This is data
// consistency only: a real completion still needs a trusted live owner.
flow transition(before: Option<MemoryEntry<string, Session>>, next: Session) -> string {
    let prior = match before {
        None() => { if next != fresh() { return "chat session must start fresh"; } return ""; }
        Some(item) => item.value,
    };
    if prior.phase == "ready" {
        let reserved = match begin(prior, next.pending) { Ok(item) => item, Err(error) => { return error; } };
        if reserved != next { return "chat session reservation changed"; }
        return "";
    }
    if prior.phase != "running" { return "completed session cannot transition"; }
    let selected = next.invocation.prior;
    let done = Completed { request = prior.pending, task = selected.task, result = selected.result, tool = selected.tool,
        outcome = selected.outcome, answer = selected.answer, records = [] };
    let outcome = TurnResult { status = 0, state = next.invocation, resolved = true, completed = Some(done) };
    let finished = match complete(prior, outcome) { Ok(item) => item, Err(error) => { return error; } };
    if finished != next { return "chat session completion changed"; }
    return "";
}

// Save only an explicitly supplied projection using the previously observed
// version. An unknown or conflicting write is never retried automatically.
public flow save(value: Session, expected: Option<MemoryEntry<string, Session>>) -> Result<MemoryVersion, string> ![Memory, Error<StorageError>, Error<IndexError>] {
    let error = invalid(value); if error != "" { return Err(error); }
    let before = match load() { Ok(item) => item, Err(problem) => { return Err(problem); } };
    if before != expected { return Err("chat history changed before save; no retry"); }
    let change = transition(before, value); if change != "" { return Err(change); }
    let condition: WriteCondition = match expected { Some(entry) => Match(entry.version), None() => Missing };
    let intent = prepare_put(HistoryStore.Rows, "latest", value, condition); let operation = operation_ref(intent);
    let receipt = match commit(intent) {
        WriteOutcome.Unknown(_) => { return Err("chat history commit unknown; no retry"); }
        WriteOutcome.NotCommitted(_, _) => { return Err("chat history commit refused; no retry"); }
        WriteOutcome.Committed(item) => item,
    };
    if receipt.operation.key != operation.key || receipt.operation.fingerprint != operation.fingerprint ||
        receipt.target.key != "latest" || receipt.target.region != "nomo-chat-history-v1" || receipt.target.store != ["Rows"] {
        return Err("chat history receipt mismatch; no retry");
    }
    let durable = match receipt.durability { StorageDurability.SqliteWalFull() => true, _ => false };
    if !durable { return Err("durable SQLite chat history receipt required"); }
    let version = match receipt.change { MemoryWriteChange.Written(item) => item, _ => { return Err("chat history version receipt required"); } };
    let after = match load() { Ok(Some(item)) => item, _ => { return Err("chat history readback missing or invalid; no retry"); } };
    if after.value != value || after.version.opaque != version.opaque { return Err("chat history readback mismatch; no retry"); }
    match expected { Some(entry) => { if entry.version.opaque == version.opaque { return Err("chat history version did not change"); } } None() => {} }
    return Ok(version);
}
